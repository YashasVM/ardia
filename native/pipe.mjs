import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { splitPipeMessages } = await import(pathToFileURL(join(process.env.PROOF_REPO ?? process.cwd(), "scripts/linux/smoke.mjs")));
class PipeCdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    child.stdio[4].on("data", (chunk) => {
      const { messages, rest } = splitPipeMessages(Buffer.concat([this.buffer, chunk]));
      this.buffer = rest;
      for (const message of messages) {
        const waiter = message.id ? this.pending.get(message.id) : null;
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.fail(new Error(`${waiter.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
        else waiter.done(message.result ?? {});
      }
    });
    const close = () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.fail(new Error(`${waiter.method}: the DevTools pipe closed`));
      this.pending.clear();
    };
    child.stdio[4].on("close", close);
    child.stdio[3].on("error", close);
  }

  send(method, params = {}, sessionId, timeout = 10000) {
    if (this.closed) return Promise.reject(new Error(`${method}: the DevTools pipe is closed`));
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`${method} timed out after ${timeout} ms`)); }, timeout);
      this.pending.set(id, { method, done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  async evaluate(sessionId, expression, timeout = 10000) {
    const reply = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeout);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "evaluation failed");
    return reply.result?.value;
  }
}


export { PipeCdp };
