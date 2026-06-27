"use strict";

importScripts("ytd-parser.js");
importScripts("ytd-optimizer.js");

self.addEventListener("message", async function (event) {
  const message = event.data || {};
  try {
    if (message.operation === "optimize") {
      const result = await self.MRIYtdOptimizer.optimize(new Uint8Array(message.buffer), message.profile, function (progress) {
        self.postMessage({ id: message.id, progress: progress });
      });
      self.postMessage({ id: message.id, ok: true, result: result }, [result.buffer]);
      return;
    }
    const report = await self.MRIYtdParser.inspect(new Uint8Array(message.buffer), message.options || {});
    self.postMessage({ id: message.id, ok: true, report: report });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: {
        code: error && error.code ? error.code : "YTD_PARSE_FAILED",
        message: error && error.message ? error.message : "Falha desconhecida ao analisar o YTD.",
      },
    });
  }
});
