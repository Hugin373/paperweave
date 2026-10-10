/**
 * Matching concept names that mean the same thing: "Point clouds" and "point-cloud", "Diffusion
 * models" and "diffusion model", "Magnetic resonance imaging (MRI)" and "MRI". Used so the assistant
 * links an existing concept instead of creating a near-duplicate.
 */

/** Full forms of common abbreviations (singular, lowercase) → the abbreviation. */
const ABBREVIATIONS: Record<string, string> = {
  "magnetic resonance imaging": "mri",
  "functional magnetic resonance imaging": "fmri",
  "computed tomography": "ct",
  "positron emission tomography": "pet",
  "single photon emission computed tomography": "spect",
  "optical coherence tomography": "oct",
  electroencephalography: "eeg",
  electrocardiography: "ecg",
  "convolutional neural network": "cnn",
  "graph neural network": "gnn",
  "recurrent neural network": "rnn",
  "generative adversarial network": "gan",
  "variational autoencoder": "vae",
  "large language model": "llm",
  "vision language model": "vlm",
  "neural radiance field": "nerf",
  "natural language processing": "nlp",
  "reinforcement learning": "rl",
  "self supervised learning": "ssl",
};

function singular(word: string) {
  if (word.length <= 3 || /(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** A comparison key for a concept name: case, punctuation, plurals and known abbreviations ignored. */
export function conceptKey(name: string): string {
  let n = name
    // Plural abbreviations ("MRIs", "CNNs") before case is lost.
    .replace(/\b([A-Z]{2,6})s\b/g, "$1")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  // "Magnetic resonance imaging (MRI)": the abbreviation in brackets is the name.
  const bracket = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(n);
  if (bracket) n = bracket[2].trim().length <= 8 ? bracket[2] : bracket[1];
  n = n
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(singular)
    .join(" ");
  return ABBREVIATIONS[n] ?? n;
}
