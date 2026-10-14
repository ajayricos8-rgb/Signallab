// Dependency-free, deliberately small local models. These are actually fitted
// to the training partition on every scan, not branded/pretrained AI services.
import { clamp, countsOf, mean, seededRandom, smooth, softmax, sum } from './math.ts';
import { classifierFeatures, prefix, timeDeltaFeature, type FittedEngine, type Sequence } from './features.ts';

const INPUTS = 11; // ten one-hot digit inputs + causal tick time delta
const HIDDEN = 8;
const STEPS = 12;
const WIDTH = INPUTS + HIDDEN + 1;
const GATE_PARAMETERS = 4 * HIDDEN * WIDTH;
const OUTPUT_OFFSET = GATE_PARAMETERS;
const BIAS_OFFSET = OUTPUT_OFFSET + 10 * HIDDEN;
const PARAMETERS = BIAS_OFFSET + 10;
const sigmoid = (value: number) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

type LstmStep = { z: number[]; gates: number[]; cell: number[]; previousCell: number[]; hidden: number[] };

export function fitLstm(sequence: Sequence, horizon: number) {
  const random = seededRandom(12383 + horizon);
  const weights = Float64Array.from({ length: PARAMETERS }, () => (random() - 0.5) * 0.18);
  const accumulators = new Float64Array(PARAMETERS).fill(0.05);
  const prior = smooth(countsOf(sequence.digits));
  for (let digit = 0; digit < 10; digit += 1) weights[BIAS_OFFSET + digit] = Math.log(prior[digit]);
  // Forget-gate bias encourages retaining context at initialization.
  for (let unit = 0; unit < HIDDEN; unit += 1) weights[(HIDDEN + unit) * WIDTH + WIDTH - 1] = 1;

  const encode = (context: Sequence, origin: number) => Array.from({ length: STEPS }, (_, step) => {
    const index = origin - STEPS + step + 1;
    return [...Array.from({ length: 10 }, (_, digit) => Number(context.digits[index] === digit)), timeDeltaFeature(context.epochs, index)];
  });
  const forward = (inputs: number[][]) => {
    let hidden = Array<number>(HIDDEN).fill(0);
    let cell = Array<number>(HIDDEN).fill(0);
    const trace: LstmStep[] = [];
    for (const input of inputs) {
      const z = [...input, ...hidden, 1];
      const gates = Array<number>(4 * HIDDEN).fill(0);
      for (let gate = 0; gate < gates.length; gate += 1) {
        let activation = 0;
        for (let k = 0; k < WIDTH; k += 1) activation += weights[gate * WIDTH + k] * z[k];
        gates[gate] = gate >= 3 * HIDDEN ? Math.tanh(activation) : sigmoid(activation);
      }
      const previousCell = cell;
      cell = cell.map((value, unit) => gates[HIDDEN + unit] * value + gates[unit] * gates[3 * HIDDEN + unit]);
      hidden = cell.map((value, unit) => gates[2 * HIDDEN + unit] * Math.tanh(value));
      trace.push({ z, gates, cell, previousCell, hidden });
    }
    const probabilities = softmax(Array.from({ length: 10 }, (_, digit) => {
      let logit = weights[BIAS_OFFSET + digit];
      for (let unit = 0; unit < HIDDEN; unit += 1) logit += weights[OUTPUT_OFFSET + digit * HIDDEN + unit] * hidden[unit];
      return logit;
    }));
    return { trace, probabilities };
  };
  const origins = Array.from({ length: Math.max(0, sequence.digits.length - horizon - STEPS + 1) }, (_, i) => i + STEPS - 1);
  const inputs = origins.map((origin) => encode(sequence, origin));
  const targets = origins.map((origin) => sequence.digits[origin + horizon]);
  const loss = () => mean(inputs.map((input, index) => -Math.log(Math.max(1e-9, forward(input).probabilities[targets[index]]))));
  const initialLoss = loss();
  const epochs = 7;
  const gradient = new Float64Array(PARAMETERS);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = origins.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let batch = 0; batch < order.length; batch += 16) {
      gradient.fill(0);
      const batchEnd = Math.min(order.length, batch + 16);
      for (let sample = batch; sample < batchEnd; sample += 1) {
        const index = order[sample];
        const { trace, probabilities } = forward(inputs[index]);
        let dh = Array<number>(HIDDEN).fill(0);
        let dc = Array<number>(HIDDEN).fill(0);
        for (let digit = 0; digit < 10; digit += 1) {
          const error = probabilities[digit] - Number(targets[index] === digit);
          gradient[BIAS_OFFSET + digit] += error;
          for (let unit = 0; unit < HIDDEN; unit += 1) {
            gradient[OUTPUT_OFFSET + digit * HIDDEN + unit] += error * trace.at(-1)!.hidden[unit];
            dh[unit] += error * weights[OUTPUT_OFFSET + digit * HIDDEN + unit];
          }
        }
        // Full backpropagation through the 12-step sequence, including all
        // input/forget/output/candidate gates and recurrent connections.
        for (let step = trace.length - 1; step >= 0; step -= 1) {
          const state = trace[step];
          const gateDerivative = Array<number>(4 * HIDDEN).fill(0);
          const previousDc = Array<number>(HIDDEN).fill(0);
          for (let unit = 0; unit < HIDDEN; unit += 1) {
            const input = state.gates[unit];
            const forget = state.gates[HIDDEN + unit];
            const output = state.gates[2 * HIDDEN + unit];
            const candidate = state.gates[3 * HIDDEN + unit];
            const tanhCell = Math.tanh(state.cell[unit]);
            const cellGradient = dc[unit] + dh[unit] * output * (1 - tanhCell * tanhCell);
            gateDerivative[unit] = cellGradient * candidate * input * (1 - input);
            gateDerivative[HIDDEN + unit] = cellGradient * state.previousCell[unit] * forget * (1 - forget);
            gateDerivative[2 * HIDDEN + unit] = dh[unit] * tanhCell * output * (1 - output);
            gateDerivative[3 * HIDDEN + unit] = cellGradient * input * (1 - candidate * candidate);
            previousDc[unit] = cellGradient * forget;
          }
          const previousDh = Array<number>(HIDDEN).fill(0);
          for (let gate = 0; gate < gateDerivative.length; gate += 1) {
            const delta = gateDerivative[gate];
            for (let k = 0; k < WIDTH; k += 1) {
              gradient[gate * WIDTH + k] += delta * state.z[k];
              if (k >= INPUTS && k < INPUTS + HIDDEN) previousDh[k - INPUTS] += delta * weights[gate * WIDTH + k];
            }
          }
          dh = previousDh;
          dc = previousDc;
        }
      }
      for (let parameter = 0; parameter < PARAMETERS; parameter += 1) {
        const value = clamp(gradient[parameter] / (batchEnd - batch) + 0.0001 * weights[parameter], -1, 1);
        accumulators[parameter] += value * value;
        weights[parameter] -= 0.035 * value / Math.sqrt(accumulators[parameter]);
      }
    }
  }
  const finalLoss = loss();
  const engine: FittedEngine = {
    id: 'lstm', family: 'ml', label: 'LSTM · 12-step / 8-cell sequence classifier',
    predict: (context) => ({ probabilities: forward(encode(context, context.digits.length - 1)).probabilities, support: origins.length, note: 'Local categorical head sums strictly above / below each barrier; equality is a loss' }),
  };
  return { engine, samples: origins.length, epochs, sequenceLength: STEPS, hiddenUnits: HIDDEN, parameters: PARAMETERS, initialLoss, finalLoss };
}

type Tree = { value: number; feature?: number; threshold?: number; left?: Tree; right?: Tree };
function predictTree(tree: Tree, features: number[]): number {
  if (tree.feature === undefined) return tree.value;
  return predictTree(features[tree.feature] <= tree.threshold! ? tree.left! : tree.right!, features);
}

/** Multinomial Newton gradient boosting, regularized depth-two trees. */
export function fitBoosting(sequence: Sequence, horizon: number) {
  const origins = Array.from({ length: Math.max(0, sequence.digits.length - horizon - 50) }, (_, i) => i + 50);
  const features = origins.map((origin) => classifierFeatures(prefix(sequence, origin + 1)));
  const targets = origins.map((origin) => sequence.digits[origin + horizon]);
  const base = smooth(countsOf(targets)).map(Math.log);
  const logits = features.map(() => [...base]);
  const thresholds = features[0].map((_, feature) => {
    const sorted = features.map((row) => row[feature]).sort((a, b) => a - b);
    return [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => sorted[Math.floor(q * (sorted.length - 1))]))];
  });
  const rounds: Tree[][] = [];
  const rate = 0.15;
  const lambda = 4;
  const allRows = features.map((_, i) => i);
  const loss = () => mean(logits.map((row, index) => -Math.log(Math.max(1e-9, softmax(row)[targets[index]]))));
  const initialLoss = loss();
  const buildTree = (rows: number[], gradient: number[], curvature: number[], depth: number): Tree => {
    const g = sum(rows.map((row) => gradient[row]));
    const h = sum(rows.map((row) => curvature[row]));
    const leaf = { value: clamp(g / (h + lambda), -2, 2) };
    if (depth === 2 || rows.length < 32) return leaf;
    let bestGain = 0.02;
    let best: { feature: number; threshold: number } | null = null;
    for (let feature = 0; feature < thresholds.length; feature += 1) for (const threshold of thresholds[feature]) {
      let leftG = 0; let leftH = 0; let leftN = 0;
      for (const row of rows) if (features[row][feature] <= threshold) { leftG += gradient[row]; leftH += curvature[row]; leftN += 1; }
      if (leftN < 16 || rows.length - leftN < 16) continue;
      const gain = leftG * leftG / (leftH + lambda) + (g - leftG) ** 2 / (h - leftH + lambda) - g * g / (h + lambda);
      if (gain > bestGain) { bestGain = gain; best = { feature, threshold }; }
    }
    if (!best) return leaf;
    const split = best;
    return { ...leaf, ...split, left: buildTree(rows.filter((row) => features[row][split.feature] <= split.threshold), gradient, curvature, depth + 1), right: buildTree(rows.filter((row) => features[row][split.feature] > split.threshold), gradient, curvature, depth + 1) };
  };
  for (let round = 0; round < 24; round += 1) {
    const probabilities = logits.map(softmax);
    const trees = Array.from({ length: 10 }, (_, digit) => {
      const gradient = targets.map((target, index) => Number(target === digit) - probabilities[index][digit]);
      const curvature = probabilities.map((row) => Math.max(1e-3, row[digit] * (1 - row[digit])));
      return buildTree(allRows, gradient, curvature, 0);
    });
    rounds.push(trees);
    logits.forEach((row, index) => row.forEach((_, digit) => { row[digit] += rate * predictTree(trees[digit], features[index]); }));
  }
  const engine: FittedEngine = {
    id: 'boosting', family: 'ml', label: 'Gradient boosting · depth-two digit classifiers',
    predict: (context) => {
      const input = classifierFeatures(context);
      const output = base.map((value, digit) => value + rate * sum(rounds.map((trees) => predictTree(trees[digit], input))));
      return { probabilities: softmax(output), support: origins.length, note: 'Local boosted trees, not an XGBoost / LightGBM service or downloaded model' };
    },
  };
  return { engine, samples: origins.length, rounds: rounds.length, depth: 2, features: features[0].length, initialLoss, finalLoss: loss() };
}
