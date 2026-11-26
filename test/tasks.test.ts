import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countTasks, parseTask, toggleTask } from "../src/agents/tasks.ts";

describe("tarefas nas notas", () => {
  it("reconhece - [ ] e - [x]", () => {
    assert.deepEqual(parseTask("- [ ] ligar pro cliente"), { indent: "", done: false, text: "ligar pro cliente" });
    assert.deepEqual(parseTask("  * [X] feito"), { indent: "  ", done: true, text: "feito" });
    assert.equal(parseTask("texto comum"), null);
    assert.deepEqual(countTasks("- [ ] a\n- [x] b\n- [ ] c\nnota"), { open: 2, done: 1 });
  });

  it("marca, desmarca e transforma uma linha em tarefa", () => {
    assert.equal(toggleTask("- [ ] a"), "- [x] a");
    assert.equal(toggleTask("- [x] a"), "- [ ] a");
    assert.equal(toggleTask("  ligar"), "  - [ ] ligar");
    assert.equal(toggleTask("- item de lista"), "- [ ] item de lista");
    assert.equal(toggleTask(""), "- [ ] ");
  });
});
