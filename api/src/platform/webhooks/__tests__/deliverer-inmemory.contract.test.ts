/**
 * Runs the shared IWebhookDeliverer contract against the in-memory
 * QueueWebhookDeliverer. This ALWAYS runs (no external dependency) and is the
 * baseline the BullMQ deliverer must match. Time is driven by a TestClock, so
 * the full multi-minute retry schedule is exercised deterministically.
 */
import { TestClock } from '../clock.js';
import { QueueWebhookDeliverer } from '../deliverer.js';
import { InMemoryEventBus } from '../event-bus.js';
import { runDelivererContract, type DelivererHarness } from './deliverer-contract.js';

function inMemoryHarness(): DelivererHarness {
  const clock = new TestClock();
  return {
    makeBus(transport) {
      const deliverer = new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 });
      return new InMemoryEventBus({ deliverer, clock });
    },
    async idle(stepMs) {
      // TestClock fires scheduled callbacks synchronously as virtual time passes.
      await clock.advance(stepMs);
    },
  };
}

runDelivererContract('in-memory', inMemoryHarness, /* fullRetrySchedule */ true);
