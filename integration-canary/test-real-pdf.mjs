import fs from "node:fs";
import { handle } from "./worker.mjs";
import filmlineWorker from "../../filmline.cc/video-worker/index.js";
import ventureFleetWorker from "../../nginx/workers/venture-fleet/src/worker.js";

async function run() {
  const pdfBytes = fs.readFileSync("/Users/johnmobley/Desktop/weyland-real-upload.pdf");
  
  console.log("PDF read. bytes:", pdfBytes.length);

  // We need to simulate the environment for the canary.
  const env = {
    CANARY_ENABLED: "true",
    CANARY_ALLOWED_EMAILS: "operator@book2film.cc",
    
    OCR_SERVICE: {
      fetch: async (url, options) => {
        console.log("Mocking OCR_SERVICE since weyland-ocr-worker requires WASM loader in CF...");
        return new Response(JSON.stringify({
          pages: [
            { page: 1, text: "The quick brown fox jumps over the lazy dog. A lighthouse keeper receives a strange message." },
            { page: 2, text: "Extracting this directly as a mock because OCR_SERVICE needs CF environment." }
          ],
          pageCount: 2
        }), { headers: { "Content-Type": "application/json" } });
      }
    },
    
    FILMLINE_VIDEO: {
      fetch: async (url, options) => {
        console.log("Calling actual filmline-video-worker...");
        const res = await filmlineWorker.fetch(new Request(url, options), {
          STORY_ENGINE: {
            fetch: async (url2, options2) => {
              console.log("Calling actual venture-fleet STORY_ENGINE...", url2);
              const r = await ventureFleetWorker.fetch(new Request(url2, options2), {
                LLAMA_ACCESS_CLIENT_ID: "mock-id",
                LLAMA_ACCESS_CLIENT_SECRET: "mock-secret"
              });
              if (!r.ok) {
                console.error("STORY_ENGINE returned not ok:", r.status, await r.clone().text());
              }
              return r;
            }
          }
        });
        if (!res.ok) {
          console.error("FILMLINE_VIDEO returned not ok:", res.status, await res.clone().text());
        }
        return res;
      }
    }
  };

  const authFetch = async (url, options) => {
    return new Response(JSON.stringify({ email: "operator@book2film.cc" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };

  // 1. Source-text endpoint (Mocked OCR)
  const req1 = new Request("https://canary.invalid/api/source-text", {
    method: "POST",
    headers: { "Authorization": "Bearer fake", "Content-Type": "application/pdf" },
    body: pdfBytes
  });
  
  const res1 = await handle(req1, env, authFetch);
  const data1 = await res1.json();
  console.log("OCR result:", data1);
  
  if (data1.error) {
    console.error("Failed to extract text:", data1.error);
    process.exit(1);
  }

  // 2. Storyboard endpoint
  const excerpt = data1.pages[0].text;
  console.log("\nChosen excerpt:", excerpt);
  
  const req2 = new Request("https://canary.invalid/api/storyboard", {
    method: "POST",
    headers: { "Authorization": "Bearer fake", "Content-Type": "application/json" },
    body: JSON.stringify({ excerpt, approved: true })
  });

  // To make venture-fleet work locally without credentials, we need to mock global fetch
  // to intercept https://llama.mobleysoft.com/v1/chat/completions and route it to http://127.0.0.1:11435
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === "https://llama.mobleysoft.com/v1/chat/completions") {
      console.log("Intercepting LLAMA fetch and routing to local Qwen (127.0.0.1:11435)");
      return originalFetch("http://127.0.0.1:11435/v1/chat/completions", {
        ...options,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url, options);
  };
  
  try {
    const res2 = await handle(req2, env, authFetch);
    const data2 = await res2.json();
    console.log("\nStoryboard result:", JSON.stringify(data2, null, 2));
    
    console.log("\nSource Fidelity & Latency Review:");
    console.log(`Latency: ${data2.latency_ms} ms`);
    console.log(`Title: ${data2.title}`);
    console.log(`Scenes count: ${data2.scenes?.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch(console.error);
