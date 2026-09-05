import {
  createErrorResponse,
  parseWorkerRequest,
  type SendResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { WorkerEngine } from "./worker-engine";

function requestIdFrom(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const requestId = Reflect.get(value, "requestId");
  return typeof requestId === "string" ? requestId : "";
}

export async function dispatchWorkerRequest(
  value: unknown,
  engine: WorkerEngine,
  send: SendResponse,
): Promise<void> {
  let request: WorkerRequest;
  try {
    request = parseWorkerRequest(value);
  } catch (error) {
    send(createErrorResponse(requestIdFrom(value), error));
    return;
  }

  try {
    switch (request.type) {
      case "import-jiten":
        await engine.importJiten(request.requestId, request.name, request.text, send);
        return;
      case "import-known":
        await engine.importKnown(request.requestId, request.name, request.text, send);
        return;
      case "load-start":
        engine.loadStart(request.datasetId, request.requestId);
        return;
      case "load-chunk":
        engine.loadChunk(request.datasetId, request.chunkIndex, request.entries, request.requestId);
        return;
      case "load-complete":
        engine.loadComplete(request.datasetId, request.requestId);
        send({
          protocolVersion: 1,
          type: "load-complete",
          requestId: request.requestId,
          datasetId: request.datasetId,
          entryCount: engine.getDatasetEntryCount(request.datasetId),
        });
        return;
      case "query":
        await engine.query(request, send);
        return;
      case "cancel":
        engine.cancel(request.requestId);
        return;
      case "dispose":
        engine.dispose();
        return;
    }
  } catch (error) {
    engine.cancel(request.requestId);
    send(createErrorResponse(request.requestId, error));
  }
}

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;
const engine = new WorkerEngine();

if (typeof workerScope.addEventListener === "function" && typeof workerScope.postMessage === "function") {
  workerScope.addEventListener("message", (event) => {
    void dispatchWorkerRequest(event.data, engine, (response) => workerScope.postMessage(response));
  });
}
