import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

export function fakeSpawn() {
  const calls = [];
  const requests = [];
  const spawn = (path, args) => {
    calls.push({ path, args });
    const child = new EventEmitter();
    const stdout = new PassThrough();
    let input = Buffer.alloc(0);
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        input = Buffer.concat([input, chunk]);
        drain();
        callback();
      },
    });
    child.stdout = stdout;
    child.stdin = stdin;
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGTERM";
      queueMicrotask(() => {
        stdout.end();
        child.emit("close");
      });
      return true;
    };
    stdout.write('{"device":"CPU","gpu":false,"ms":1}\n');

    function drain() {
      if (input.length < 4) return;
      const count = input.readUInt32LE(0);
      let offset = 4;
      const texts = [];
      for (let index = 0; index < count; index += 1) {
        if (input.length < offset + 4) return;
        const length = input.readUInt32LE(offset);
        offset += 4;
        if (input.length < offset + length) return;
        texts.push(input.subarray(offset, offset + length).toString("utf8"));
        offset += length;
      }
      requests.push(texts);
      input = input.subarray(offset);
      const output = [u32(0)];
      for (const text of texts) {
        const bytes = Buffer.from(text, "utf8");
        const value = Buffer.from("Alice", "utf8");
        const start = bytes.indexOf(value);
        if (start < 0) {
          output.push(u32(0));
          continue;
        }
        output.push(u32(1), u32(start), u32(start + value.length), u32(0));
        output.push(Buffer.from(["private_person".length]), Buffer.from("private_person", "utf8"));
      }
      stdout.write(Buffer.concat(output));
      drain();
    }
    return child;
  };
  return { calls, requests, spawn };
}

export function assets(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-qoder-privacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modelPath = join(directory, "privacy-filter-q8-80efc1803eda.gguf");
  const executablePath = join(directory, "pf-serve.exe");
  writeFileSync(modelPath, "fixture");
  writeFileSync(executablePath, "fixture");
  return { directory, modelPath, executablePath };
}
