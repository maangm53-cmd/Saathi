import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/saathi-microphone.js", import.meta.url), "utf8");
const OUTPUT_RATE = 16_000;
const PACKET_SAMPLES = 1_280;

// Exercise the actual browser worklet in an isolated audio-thread-like realm.
// structuredClone transfers (and detaches) each outgoing buffer, as a real port does.
function microphone(inputRate) {
  const packets = [];
  const transferredBuffers = new Set();
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        postMessage(buffer, transfer) {
          assert.equal(Object.prototype.toString.call(buffer), "[object ArrayBuffer]");
          assert.equal(transfer.length, 1, "send one mono PCM buffer, with no channel wrappers");
          assert.equal(transfer[0], buffer, "transfer the actual message buffer");
          assert.equal(buffer.byteLength, PACKET_SAMPLES * Int16Array.BYTES_PER_ELEMENT);
          assert.ok(!transferredBuffers.has(buffer), "each packet needs a fresh transferable buffer");
          transferredBuffers.add(buffer);
          const received = structuredClone(buffer, { transfer: [buffer] });
          assert.equal(buffer.byteLength, 0, "the sender's transferred buffer is detached");
          packets.push(new Int16Array(received));
        },
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    sampleRate: inputRate,
    registerProcessor(name, implementation) {
      assert.equal(name, "saathi-microphone");
      assert.equal(Processor, undefined, "register exactly one worklet");
      Processor = implementation;
    },
  }, { filename: "saathi-microphone.js", timeout: 1_000 });
  assert.ok(Processor, "the worklet registered successfully");
  const processor = new Processor();
  function feed(input, secondChannel) {
    for (let offset = 0; offset < input.length; offset += 128) {
      const first = input.subarray(offset, offset + 128);
      const channels = secondChannel ? [first, secondChannel.subarray(offset, offset + 128)] : [first];
      assert.equal(processor.process([channels]), true, "keep the audio processor alive");
    }
  }
  function samples() {
    const values = new Int16Array(packets.length * PACKET_SAMPLES);
    packets.forEach((packet, index) => values.set(packet, index * PACKET_SAMPLES));
    return values;
  }
  return { processor, feed, packets, samples };
}

// An independent integral reference: integrate the held input signal at each
// 16 kHz output boundary using a prefix sum, rather than the worklet's loop.
function referencePcm(input, inputRate, outputCount) {
  const integral = new Float64Array(input.length + 1);
  for (let i = 0; i < input.length; i++) integral[i + 1] = integral[i] + input[i];
  function area(position) {
    const whole = Math.min(input.length, Math.floor(position));
    return integral[whole] + (whole < input.length ? input[whole] * (position - whole) : 0);
  }
  const width = inputRate / OUTPUT_RATE;
  return Int16Array.from({ length: outputCount }, (_, i) => {
    const average = (area((i + 1) * width) - area(i * width)) / width;
    const clipped = Math.max(-1, Math.min(1, average));
    return Math.round(clipped * (clipped < 0 ? 32768 : 32767));
  });
}

for (const inputRate of [48_000, 44_100]) {
  test(`${inputRate} Hz: emit exactly one 80 ms mono packet only after enough input`, () => {
    const worklet = microphone(inputRate);
    const packetInputLength = inputRate * 0.08;
    assert.ok(Number.isInteger(packetInputLength));
    worklet.feed(new Float32Array(packetInputLength - 1).fill(0.5));
    assert.equal(worklet.packets.length, 0, "never publish a partial packet");
    worklet.feed(new Float32Array([0.5]));
    assert.equal(worklet.packets.length, 1);
    assert.equal(worklet.packets[0].length, PACKET_SAMPLES);
    assert.equal(worklet.packets[0].length / OUTPUT_RATE, 0.08);
    // Half-scale lands exactly on a PCM rounding tie; fractional 44.1kHz
    // integration can fall on either side by floating-point epsilon.
    assert.ok(worklet.packets[0].every(value => Math.abs(value - 16384) <= 1));
  });

  test(`${inputRate} Hz: preserve every sample boundary across 128-frame blocks and transfers`, () => {
    // 1.28 seconds is an exact number of 128-frame device blocks at both rates,
    // and exactly sixteen 80 ms output packets, including at noninteger 44.1k/16k.
    const inputLength = Math.round(inputRate * 1.28);
    assert.equal(inputLength % 128, 0);
    const input = Float32Array.from({ length: inputLength }, (_, i) =>
      0.42 * Math.sin(i * 0.027) + 0.19 * Math.cos(i * 0.113) + ((i % 127) === 0 ? 0.16 : 0),
    );
    const worklet = microphone(inputRate);
    const boundary = 128 * 17;
    worklet.feed(input.subarray(0, boundary));
    assert.equal(worklet.processor.process([]), true);
    assert.equal(worklet.processor.process([[]]), true);
    worklet.feed(input.subarray(boundary));
    assert.equal(worklet.packets.length, 16, "no early, dropped, or duplicate packets");
    const actual = worklet.samples();
    const expected = referencePcm(input, inputRate, 16 * PACKET_SAMPLES);
    assert.equal(actual.length, expected.length);
    let maxError = 0;
    for (let i = 0; i < actual.length; i++) maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
    assert.ok(maxError <= 1, `PCM sequence differs by ${maxError}; at most one rounding unit is allowed`);
  });

  test(`${inputRate} Hz: keep a 1 kHz tone at the same frequency and useful amplitude`, () => {
    const input = Float32Array.from({ length: Math.round(inputRate * 1.28) }, (_, i) => 0.65 * Math.sin(2 * Math.PI * 1000 * i / inputRate));
    const worklet = microphone(inputRate);
    worklet.feed(input);
    const output = worklet.samples();
    const crossings = [];
    let squares = 0;
    let sum = 0;
    for (let i = 0; i < output.length; i++) {
      squares += (output[i] / 32768) ** 2;
      sum += output[i];
      if (i && output[i - 1] <= 0 && output[i] > 0) crossings.push(i);
    }
    assert.ok(crossings.length > 1200, "enough cycles survive for a stable frequency estimate");
    const frequency = (crossings.length - 1) * OUTPUT_RATE / (crossings.at(-1) - crossings[0]);
    assert.ok(Math.abs(frequency - 1000) < 0.2, `expected 1000 Hz, measured ${frequency}`);
    const rms = Math.sqrt(squares / output.length);
    assert.ok(rms > 0.44 && rms < 0.47, `tone amplitude should remain near 0.65 / sqrt(2), measured ${rms}`);
    assert.ok(Math.abs(sum / output.length) < 3, "resampling should not introduce a DC offset");
  });
}

test("clip out-of-range input to signed 16-bit PCM and emit one mono channel", () => {
  const worklet = microphone(48_000);
  for (const value of [2, -2, 0, 0.25, -0.25]) {
    const firstChannel = new Float32Array(3 * PACKET_SAMPLES).fill(value);
    const unrelatedChannel = new Float32Array(firstChannel.length).fill(-0.75);
    worklet.feed(firstChannel, unrelatedChannel);
  }
  assert.equal(worklet.packets.length, 5);
  for (const [i, expected] of [32767, -32768, 0, 8192, -8192].entries()) {
    assert.ok(worklet.packets[i].every(value => value === expected), `packet ${i} should contain mono PCM value ${expected}`);
  }
});
