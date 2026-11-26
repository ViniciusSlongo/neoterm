import { spawn } from "node:child_process";

/** Copia texto para o clipboard do macOS (pbcopy). */
export function copyText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy saiu com ${code}`))));
    child.stdin.end(text);
  });
}
