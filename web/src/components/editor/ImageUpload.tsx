/**
 * TipTap Image Upload Extension
 * Handles paste/drop events for images and manages upload flow
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Editor } from '@tiptap/react';
import { uploadFile, isImageFile } from '@/services/upload';
import { registerUpload, updateUploadProgress, unregisterUpload } from '@/services/uploadTracker';

export interface ImageUploadOptions {
  /**
   * Callback when an image upload starts
   */
  onUploadStart?: (file: File) => void;
  /**
   * Callback when an image upload completes
   */
  onUploadComplete?: (cdnUrl: string) => void;
  /**
   * Callback when an image upload fails
   */
  onUploadError?: (error: Error) => void;
  /**
   * AbortController for cancelling uploads on navigation/cleanup
   * When aborted, pending uploads will be cancelled and won't update the document
   */
  abortController?: AbortController;
}

export interface ImageUploadStorage {
  /**
   * Opens the image file picker. Wired up by the Editor component to click a
   * persistent hidden <input> (see Editor.tsx). Null until the editor mounts.
   * Using a persistent, DOM-attached input lets E2E tests drive uploads via
   * Playwright's setInputFiles() instead of the native file-chooser dialog,
   * which never fires in headless-Linux CI.
   */
  triggerPicker: (() => void) | null;
}

export const ImageUploadExtension = Extension.create<ImageUploadOptions, ImageUploadStorage>({
  name: 'imageUpload',

  addOptions() {
    return {
      onUploadStart: undefined,
      onUploadComplete: undefined,
      onUploadError: undefined,
      abortController: undefined,
    };
  },

  addStorage() {
    return {
      triggerPicker: null,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor as Editor;
    const options = this.options;

    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handlePaste(view, event) {
            const items = Array.from(event.clipboardData?.items || []);
            const imageItem = items.find(
              (item) => item.type.startsWith('image/')
            );

            if (!imageItem) {
              return false;
            }

            event.preventDefault();

            const file = imageItem.getAsFile();
            if (!file) return false;

            handleImageUpload(editor, file, options);
            return true;
          },

          handleDrop(view, event) {
            const files = Array.from(event.dataTransfer?.files || []);
            const imageFiles = files.filter((file) => isImageFile(file.type));

            if (imageFiles.length === 0) {
              return false;
            }

            event.preventDefault();

            // Upload all dropped images
            imageFiles.forEach((file) => {
              handleImageUpload(editor, file, options);
            });

            return true;
          },
        },
      }),
    ];
  },
});

/**
 * Handle image upload and insertion into editor.
 * Used by paste/drop (the ProseMirror plugin above) and by the persistent
 * file <input> mounted in the Editor component.
 */
export async function handleImageUpload(
  editor: Editor,
  file: File,
  options: ImageUploadOptions
) {
  const signal = options.abortController?.signal;

  // Check if already aborted (e.g., user navigated away before upload started)
  if (signal?.aborted) {
    return;
  }

  options.onUploadStart?.(file);

  // Generate unique upload ID for tracking navigation warnings
  const uploadId = crypto.randomUUID();
  registerUpload(uploadId, file.name);

  // Create a data URL for immediate preview
  const dataUrl = await fileToDataUrl(file);

  // Check again after async operation
  if (signal?.aborted) {
    return;
  }

  // Insert image with data URL for immediate preview. Stamp the uploadId so the
  // async CDN-URL swap below can find THIS node — even if another in-flight image
  // happens to share the same data URL (identical files produce identical URLs).
  editor
    .chain()
    .focus()
    .setImage({
      src: dataUrl,
      alt: file.name,
      title: file.name,
      uploadId,
    })
    .run();

  try {
    const result = await uploadFile(
      file,
      (progress) => {
        // Update global tracker for navigation warning
        updateUploadProgress(uploadId, progress.progress);
      },
      signal
    );

    // Check if aborted before updating the editor
    // This prevents updating a stale editor after navigation
    if (signal?.aborted) {
      console.log('Image upload completed but was cancelled - not updating editor');
      return;
    }

    // Replace the data URL with the CDN URL.
    // Find this upload's image node by its uploadId (not by src — identical files
    // share a data URL, so a src match could hit the wrong node).
    const { state, view } = editor;
    const { doc } = state;

    let imagePos: number | null = null;

    doc.descendants((node: ProseMirrorNode, pos: number) => {
      if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
        imagePos = pos;
        return false; // Stop searching
      }
      return true;
    });

    if (imagePos !== null) {
      // Update the image src to CDN URL and clear the transient uploadId.
      // Relative URLs work via the Vite proxy.
      const transaction = state.tr.setNodeMarkup(imagePos, undefined, {
        ...doc.nodeAt(imagePos)?.attrs,
        src: result.cdnUrl,
        uploadId: null,
      });
      view.dispatch(transaction);
    }

    // Upload complete - unregister from tracker
    unregisterUpload(uploadId);
    options.onUploadComplete?.(result.cdnUrl);
  } catch (error) {
    // Upload failed - unregister from tracker
    unregisterUpload(uploadId);
    // Don't report cancellation as an error - it's intentional
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.log('Image upload cancelled');
      return;
    }

    console.error('Image upload failed:', error);
    options.onUploadError?.(
      error instanceof Error ? error : new Error('Upload failed')
    );

    // Optionally remove the failed image or show error state
    // For now, leave the data URL as fallback
  }
}

/**
 * Convert a File to a data URL
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
