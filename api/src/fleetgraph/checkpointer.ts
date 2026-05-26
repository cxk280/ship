// Postgres-backed LangGraph checkpointer.
// Required (not MemorySaver) because EB is multi-instance/ephemeral: an interrupted
// HITL run must survive a deploy and be resumable from any instance.
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

let saverPromise: Promise<PostgresSaver> | null = null;

export function getCheckpointer(): Promise<PostgresSaver> {
  if (!saverPromise) {
    saverPromise = (async () => {
      const connString = process.env.DATABASE_URL;
      if (!connString) throw new Error('DATABASE_URL required for FleetGraph checkpointer');
      const saver = PostgresSaver.fromConnString(connString);
      await saver.setup(); // creates checkpoint tables if missing (idempotent)
      return saver;
    })();
  }
  return saverPromise;
}
