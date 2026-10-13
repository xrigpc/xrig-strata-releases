"""Strata lane qualification probes. Runs with the stack's own Python (stdlib only).
Usage: qualify.py PROFILE PORT ENGINE_LOG  -> prints one JSON result object; exit 1 on failure."""
import base64, json, random, struct, sys, time, urllib.request, zlib

profile = json.load(open(sys.argv[1]))
port, engine_log = int(sys.argv[2]), sys.argv[3]
base = f"http://127.0.0.1:{port}"
q = profile["qualification"]
result = {"gpu_arch": profile["platform"]["gpu_arch"], "model": profile["model"]["model_name"]}


def get(path):
    return json.load(urllib.request.urlopen(base + path, timeout=10))


def chat(content, max_tokens, effort="none"):
    body = {"model": profile["model"]["model_name"], "max_tokens": max_tokens, "reasoning_effort": effort,
            "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=900))
    return r, time.time() - t


def png(w=128, h=128):  # a red square on white, stdlib only
    rows = b"".join(b"\x00" + b"".join(b"\xff\x00\x00" if 24 <= x < 104 and 24 <= y < 104 else b"\xff\xff\xff"
                                        for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def words(n_tokens, rng):  # ~4 chars/token of fresh pseudo-words: defeats the prefix cache
    syl = ["ka", "ri", "to", "men", "sal", "ve", "dor", "qu", "lin", "pha", "ex", "or", "ta", "bri", "un"]
    return " ".join("".join(rng.choice(syl) for _ in range(rng.randint(1, 3))) for _ in range(int(n_tokens * 0.62)))


h = get("/health")
models = get("/v1/models")
result["health"] = h.get("status") == "ok" and h.get("loaded") is True
result["models_id_match"] = any(m.get("id") == profile["model"]["model_name"] for m in models.get("data", []))
r, _ = chat("What is 2+3? Answer with the number only.", 200, "low")
msg = r["choices"][0]["message"]
result["text_inference"] = "5" in (msg.get("content") or "")
result["reasoning_content"] = bool(msg.get("reasoning_content"))
img = "data:image/png;base64," + base64.b64encode(png()).decode()
r, _ = chat([{"type": "text", "text": "What color is the square? One word."},
             {"type": "image_url", "image_url": {"url": img}}], 40)
result["vision_projector"] = "red" in (r["choices"][0]["message"].get("content") or "").lower()
log = open(engine_log, errors="replace").read()
result["gpu_device_evidence"] = f"({profile['platform']['gpu_arch']})" in log and "GPU 0:" in log

runs = []
for level in q["levels"]:
    for i in range(q["runs_per_level"]):
        rng = random.Random(level * 31 + i)
        r, wall = chat(words(level, rng) + "\n\nWrite a long paragraph about the history of bridges.", 100)
        t = r.get("timings", {})
        runs.append({"level": level, "run": i, "prompt": r["usage"]["prompt_tokens"],
                     "gen": r["usage"]["completion_tokens"], "wall": round(wall, 1),
                     "prefill": round(t.get("prompt_per_second", 0), 1), "decode": round(t.get("predicted_per_second", 0), 1)})
        print(json.dumps(runs[-1]), file=sys.stderr, flush=True)
result["runs"] = runs
decodes = [x["decode"] for x in runs if x["gen"] >= 30]
result["decode_mean"] = round(sum(decodes) / max(len(decodes), 1), 1)
p32 = [x["prefill"] for x in runs if x["level"] == 32000]
result["prefill_32k_mean"] = round(sum(p32) / max(len(p32), 1), 1)
result["throughput_ok"] = (len(decodes) == len(runs) and result["decode_mean"] >= q["min_decode_tok_s_mean"]
                           and min(decodes) >= q["min_decode_tok_s_run"] and result["prefill_32k_mean"] >= q["min_prefill_tok_s_32k"])
checks = ["health", "models_id_match", "text_inference", "reasoning_content", "vision_projector", "gpu_device_evidence", "throughput_ok"]
result["passed"] = all(result[c] for c in checks)
print(json.dumps(result))
sys.exit(0 if result["passed"] else 1)
