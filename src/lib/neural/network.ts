// signal-net: a small, fully self-contained neural network.
//
// This is a real multi-layer perceptron trained from scratch inside the app —
// no API key, no hosted inference, no download, no cost. Everything here is
// pure arithmetic over typed arrays with a seeded PRNG, so the same tick
// stream always produces the same weights, the same forecast and the same
// measured skill. That determinism is a hard requirement: the analysis runs in
// Web Workers and is re-run on every market, and a model that changed its
// answer between two identical analyses could not be validated out of sample.
//
// The implementation is deliberately minimal and auditable:
//   * dense layers with ReLU hidden activations and a softmax head,
//   * softmax cross-entropy loss with L2 weight decay,
//   * mini-batch Adam with gradient clipping,
//   * early stopping on a held-out validation slice.
// Nothing is imported, so the same code runs in Node (tests) and the browser.

/* -------------------------------------------------------------------------- */
/* Seeded randomness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Mulberry32: a 32-bit PRNG with a full 2^32 period. Used for weight
 * initialisation and batch shuffling so a run is reproducible from its seed.
 */
export function createRng(seed: number): () => number {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal draw from a uniform generator. */
function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* -------------------------------------------------------------------------- */
/* Network shape                                                              */
/* -------------------------------------------------------------------------- */

export type NetworkLayer = {
  /** Row-major [outputs][inputs] weight matrix. */
  weights: Float64Array;
  biases: Float64Array;
  inputDim: number;
  outputDim: number;
};

export type Network = {
  /** Input → hidden → … → output dimensions, including the input and outputs. */
  shape: number[];
  layers: NetworkLayer[];
};

export type NetworkSpec = {
  inputDim: number;
  /** Widths of the hidden layers, in order. Empty = plain softmax regression. */
  hidden: readonly number[];
  outputs: number;
  seed: number;
  learningRate?: number;
  l2?: number;
  epochs?: number;
  batchSize?: number;
  /** Epochs without validation improvement before training stops. */
  patience?: number;
};

/**
 * He-normal initialisation for ReLU layers and a small normal for the output
 * layer. Bias terms start at zero.
 */
export function createNetwork(spec: NetworkSpec): Network {
  const rng = createRng(spec.seed);
  const shape = [spec.inputDim, ...spec.hidden, spec.outputs].map((value) => Math.max(1, Math.trunc(value)));
  for (let index = 1; index < shape.length; index += 1) {
    if (!Number.isFinite(shape[index])) throw new Error('Network shape must be finite.');
  }
  const layers: NetworkLayer[] = [];
  for (let index = 1; index < shape.length; index += 1) {
    const inputDim = shape[index - 1];
    const outputDim = shape[index];
    const isOutput = index === shape.length - 1;
    const scale = isOutput ? Math.sqrt(1 / inputDim) : Math.sqrt(2 / inputDim);
    const weights = new Float64Array(inputDim * outputDim);
    for (let position = 0; position < weights.length; position += 1) weights[position] = gaussian(rng) * scale;
    layers.push({ weights, biases: new Float64Array(outputDim), inputDim, outputDim });
  }
  return { shape, layers };
}

/* -------------------------------------------------------------------------- */
/* Forward pass                                                               */
/* -------------------------------------------------------------------------- */

const RELU = (value: number) => (value > 0 ? value : 0);

/** Raw logits for one already-standardised feature vector. */
export function forward(network: Network, features: ArrayLike<number>): Float64Array {
  let activations = Float64Array.from(features);
  for (let index = 0; index < network.layers.length; index += 1) {
    const layer = network.layers[index];
    const output = new Float64Array(layer.outputDim);
    for (let row = 0; row < layer.outputDim; row += 1) {
      let total = layer.biases[row];
      const offset = row * layer.inputDim;
      for (let column = 0; column < layer.inputDim; column += 1) total += layer.weights[offset + column] * activations[column];
      output[row] = index === network.layers.length - 1 ? total : RELU(total);
    }
    activations = output;
  }
  return activations;
}

/** Numerically stable softmax. */
export function softmax(logits: ArrayLike<number>, temperature = 1): Float64Array {
  const scale = Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  let max = -Infinity;
  for (let index = 0; index < logits.length; index += 1) {
    const value = logits[index] / scale;
    if (value > max) max = value;
  }
  const output = new Float64Array(logits.length);
  let total = 0;
  for (let index = 0; index < logits.length; index += 1) {
    const value = Math.exp(logits[index] / scale - max);
    output[index] = value;
    total += value;
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    output.fill(1 / logits.length);
    return output;
  }
  for (let index = 0; index < output.length; index += 1) output[index] /= total;
  return output;
}

/** Cross-entropy of one softmax output against a class index. */
export function crossEntropy(probabilities: ArrayLike<number>, label: number): number {
  const value = probabilities[label];
  return -Math.log(Math.max(1e-12, Number.isFinite(value) ? value : 1e-12));
}

export function parameterCount(network: Network): number {
  return network.layers.reduce((total, layer) => total + layer.weights.length + layer.biases.length, 0);
}

export function cloneNetwork(network: Network): Network {
  return {
    shape: [...network.shape],
    layers: network.layers.map((layer) => ({
      weights: Float64Array.from(layer.weights),
      biases: Float64Array.from(layer.biases),
      inputDim: layer.inputDim,
      outputDim: layer.outputDim,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Training                                                                   */
/* -------------------------------------------------------------------------- */

export type TrainingRow = { features: Float64Array; label: number };

export type TrainingResult = {
  network: Network;
  epochsRun: number;
  bestEpoch: number;
  bestValidationLoss: number | null;
  trainingLoss: number | null;
};

type Cache = { activations: Float64Array[]; preActivations: Float64Array[] };

function forwardCached(network: Network, features: Float64Array): { logits: Float64Array; cache: Cache } {
  const activations: Float64Array[] = [features];
  const preActivations: Float64Array[] = [];
  let current: Float64Array = features;
  for (let index = 0; index < network.layers.length; index += 1) {
    const layer = network.layers[index];
    const output = new Float64Array(layer.outputDim);
    for (let row = 0; row < layer.outputDim; row += 1) {
      let total = layer.biases[row];
      const offset = row * layer.inputDim;
      for (let column = 0; column < layer.inputDim; column += 1) total += layer.weights[offset + column] * current[column];
      output[row] = total;
    }
    preActivations.push(output);
    const next = index === network.layers.length - 1 ? output : output.map(RELU);
    activations.push(next);
    current = next;
  }
  return { logits: current, cache: { activations, preActivations } };
}

/** Mean cross-entropy over a set of rows (no gradient). */
export function evaluateLoss(network: Network, rows: readonly TrainingRow[], l2 = 0): number {
  if (!rows.length) return 0;
  let total = 0;
  for (const row of rows) total += crossEntropy(softmax(forward(network, row.features)), row.label);
  let penalty = 0;
  if (l2 > 0) {
    for (const layer of network.layers) for (const weight of layer.weights) penalty += weight * weight;
  }
  return total / rows.length + l2 * penalty;
}

/**
 * Fit the network with Adam. Returns the weights of the epoch with the lowest
 * validation loss (early stopping), so an over-trained net is never used.
 */
export function trainNetwork(spec: NetworkSpec, train: readonly TrainingRow[], validation: readonly TrainingRow[]): TrainingResult {
  const network = createNetwork(spec);
  const epochs = Math.max(1, Math.trunc(spec.epochs ?? 12));
  const batchSize = Math.max(1, Math.trunc(spec.batchSize ?? 32));
  const learningRate = Number.isFinite(spec.learningRate) ? (spec.learningRate as number) : 0.01;
  const l2 = Number.isFinite(spec.l2) ? Math.max(0, spec.l2 as number) : 1e-4;
  const patience = Math.max(1, Math.trunc(spec.patience ?? 3));
  if (!train.length) return { network, epochsRun: 0, bestEpoch: 0, bestValidationLoss: null, trainingLoss: null };

  const moments = network.layers.map((layer) => ({
    mw: new Float64Array(layer.weights.length),
    vw: new Float64Array(layer.weights.length),
    mb: new Float64Array(layer.biases.length),
    vb: new Float64Array(layer.biases.length),
  }));
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  let step = 0;

  const rng = createRng(spec.seed + 0x9e3779b9);
  const order = train.map((_, index) => index);
  let best: Network | null = null;
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;
  let stale = 0;
  let epochsRun = 0;
  let lastTrainingLoss = evaluateLoss(network, train);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    epochsRun = epoch + 1;
    // Fisher–Yates shuffle from the seeded generator: identical batches on
    // every run, no dependence on the host's Math.random.
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      step += 1;
      const gradWeights = network.layers.map((layer) => new Float64Array(layer.weights.length));
      const gradBiases = network.layers.map((layer) => new Float64Array(layer.biases.length));

      for (const index of batch) {
        const row = train[index];
        const { logits, cache } = forwardCached(network, row.features);
        const probabilities = softmax(logits);
        // d(loss)/d(logits) for softmax + cross-entropy, averaged over the batch.
        let delta = new Float64Array(probabilities.length);
        for (let output = 0; output < probabilities.length; output += 1) {
          delta[output] = (probabilities[output] - (output === row.label ? 1 : 0)) / batch.length;
        }
        for (let layerIndex = network.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
          const layer = network.layers[layerIndex];
          const input = cache.activations[layerIndex];
          const gradientWeights = gradWeights[layerIndex];
          const gradientBiases = gradBiases[layerIndex];
          for (let rowIndex = 0; rowIndex < layer.outputDim; rowIndex += 1) {
            const value = delta[rowIndex];
            if (value === 0) continue;
            const offset = rowIndex * layer.inputDim;
            for (let column = 0; column < layer.inputDim; column += 1) gradientWeights[offset + column] += value * input[column];
            gradientBiases[rowIndex] += value;
          }
          if (layerIndex > 0) {
            const previous = network.layers[layerIndex - 1];
            const next = new Float64Array(previous.outputDim);
            for (let column = 0; column < layer.outputDim; column += 1) {
              const value = delta[column];
              if (value === 0) continue;
              const offset = column * layer.inputDim;
              for (let inputIndex = 0; inputIndex < layer.inputDim; inputIndex += 1) next[inputIndex] += value * layer.weights[offset + inputIndex];
            }
            const pre = cache.preActivations[layerIndex - 1];
            for (let inputIndex = 0; inputIndex < next.length; inputIndex += 1) next[inputIndex] *= pre[inputIndex] > 0 ? 1 : 0;
            delta = next;
          }
        }
      }

      // Clip the batch gradient, then take an Adam step with decoupled L2.
      let norm = 0;
      for (const gradient of gradWeights) for (const value of gradient) norm += value * value;
      for (const gradient of gradBiases) for (const value of gradient) norm += value * value;
      const clip = norm > 25 ? 5 / Math.sqrt(norm) : 1;
      const correction1 = 1 - beta1 ** step;
      const correction2 = 1 - beta2 ** step;

      for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
        const layer = network.layers[layerIndex];
        const moment = moments[layerIndex];
        for (let position = 0; position < layer.weights.length; position += 1) {
          const gradient = gradWeights[layerIndex][position] * clip + l2 * layer.weights[position];
          moment.mw[position] = beta1 * moment.mw[position] + (1 - beta1) * gradient;
          moment.vw[position] = beta2 * moment.vw[position] + (1 - beta2) * gradient * gradient;
          layer.weights[position] -= learningRate * (moment.mw[position] / correction1) / (Math.sqrt(moment.vw[position] / correction2) + epsilon);
        }
        for (let position = 0; position < layer.biases.length; position += 1) {
          const gradient = gradBiases[layerIndex][position] * clip;
          moment.mb[position] = beta1 * moment.mb[position] + (1 - beta1) * gradient;
          moment.vb[position] = beta2 * moment.vb[position] + (1 - beta2) * gradient * gradient;
          layer.biases[position] -= learningRate * (moment.mb[position] / correction1) / (Math.sqrt(moment.vb[position] / correction2) + epsilon);
        }
      }
    }

    const validationLoss = validation.length ? evaluateLoss(network, validation, l2) : evaluateLoss(network, train, l2);
    if (Number.isFinite(validationLoss) && validationLoss < bestLoss - 1e-6) {
      bestLoss = validationLoss;
      best = cloneNetwork(network);
      bestEpoch = epochsRun;
      stale = 0;
    } else {
      stale += 1;
      if (stale >= patience) break;
    }
    lastTrainingLoss = evaluateLoss(network, train, l2);
  }

  return {
    // If no epoch beat the starting point (a tiny, noisy validation slice),
    // fall back to the trained weights rather than the random initialisation.
    network: best ?? cloneNetwork(network),
    epochsRun,
    bestEpoch,
    bestValidationLoss: Number.isFinite(bestLoss) ? bestLoss : null,
    trainingLoss: Number.isFinite(lastTrainingLoss) ? lastTrainingLoss : null,
  };
}
