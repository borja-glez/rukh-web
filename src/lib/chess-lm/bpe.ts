// Applies a BPE model trained with Hugging Face `tokenizers` (`models.BPE` with a
// `WhitespaceSplit` pre-tokenizer, no continuing-subword prefix and no end-of-word suffix) to
// UCI text. It reads the `tokenizer.json` that `Tokenizer.save()` writes and reproduces the
// encoder: split on whitespace, start from single characters and merge the adjacent pair with
// the lowest merge rank (leftmost on ties) until nothing merges, then map symbols to ids.
// Only that subset is implemented: a file with dropout, `fuse_unk`, `byte_fallback`, an affix or
// another pre-tokenizer is rejected by the constructor instead of being encoded incorrectly.

export interface BpeAddedToken {
  id: number;
  content: string;
  special?: boolean;
}

export interface BpeFile {
  model: {
    type?: string;
    unk_token?: string | null;
    ignore_merges?: boolean;
    dropout?: number | null;
    continuing_subword_prefix?: string | null;
    end_of_word_suffix?: string | null;
    fuse_unk?: boolean;
    byte_fallback?: boolean;
    vocab: Record<string, number>;
    merges: string[] | [string, string][];
  };
  pre_tokenizer?: { type?: string } | null;
  added_tokens?: BpeAddedToken[];
}

export const DEFAULT_UNK_TOKEN = '<unk>';

/** Pre-tokenizers this loader reproduces; anything else splits words differently. */
const SUPPORTED_PRE_TOKENIZERS = ['WhitespaceSplit'];

/**
 * Rejects a `tokenizer.json` whose options this loader does not implement, instead of encoding
 * it as if they held their default value. The supported subset is listed in the README.
 */
function assertSupported(file: BpeFile): void {
  const { model } = file;
  const unsupported = (option: string, value: unknown, expected: string): Error =>
    new Error(
      `unsupported BPE model: ${option} is ${JSON.stringify(value) ?? 'undefined'}, ` +
        `this loader only supports ${expected}`,
    );

  if (model.type !== undefined && model.type !== 'BPE') {
    throw unsupported('model.type', model.type, '"BPE"');
  }
  if (model.dropout !== undefined && model.dropout !== null) {
    throw unsupported('model.dropout', model.dropout, 'null');
  }
  for (const option of ['continuing_subword_prefix', 'end_of_word_suffix'] as const) {
    const value = model[option];
    if (value !== undefined && value !== null && value !== '') {
      throw unsupported(`model.${option}`, value, 'null or ""');
    }
  }
  for (const option of ['fuse_unk', 'byte_fallback'] as const) {
    if (model[option] === true) throw unsupported(`model.${option}`, true, 'false');
  }
  const preTokenizer = file.pre_tokenizer;
  if (preTokenizer != null && !SUPPORTED_PRE_TOKENIZERS.includes(preTokenizer.type ?? '')) {
    throw unsupported(
      'pre_tokenizer.type',
      preTokenizer.type,
      SUPPORTED_PRE_TOKENIZERS.map((type) => `"${type}"`).join(', '),
    );
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class BpeTokenizer {
  readonly vocab: ReadonlyMap<string, number>;
  readonly tokens: readonly string[];
  readonly unkId: number;
  /** Merge rank by `a\u0000b` key (the pair separator cannot appear in a token). */
  private readonly ranks: Map<string, number>;
  private readonly addedTokens: Map<string, number>;
  private readonly addedPattern: RegExp | null;
  private readonly ignoreMerges: boolean;

  constructor(file: BpeFile) {
    assertSupported(file);
    const { model } = file;
    this.vocab = new Map(Object.entries(model.vocab));
    const size = Math.max(-1, ...this.vocab.values()) + 1;
    const tokens: string[] = new Array<string>(size).fill('');
    for (const [token, id] of this.vocab) tokens[id] = token;
    this.tokens = tokens;

    const unkToken = model.unk_token ?? DEFAULT_UNK_TOKEN;
    const unkId = this.vocab.get(unkToken);
    if (unkId === undefined) throw new Error(`BPE vocabulary has no ${unkToken} token`);
    this.unkId = unkId;
    this.ignoreMerges = model.ignore_merges ?? false;

    this.ranks = new Map();
    model.merges.forEach((merge, rank) => {
      const [a, b] = typeof merge === 'string' ? splitMerge(merge) : merge;
      if (!this.vocab.has(a) || !this.vocab.has(b) || !this.vocab.has(a + b)) return;
      this.ranks.set(pairKey(a, b), rank);
    });

    this.addedTokens = new Map();
    for (const added of file.added_tokens ?? []) this.addedTokens.set(added.content, added.id);
    const contents = [...this.addedTokens.keys()].sort((x, y) => y.length - x.length);
    this.addedPattern =
      contents.length > 0 ? new RegExp(`(${contents.map(escapeRegExp).join('|')})`) : null;
  }

  get size(): number {
    return this.tokens.length;
  }

  /** Ids of the tokens of `text`, applying added tokens first and BPE to the rest. */
  encode(text: string): number[] {
    return this.tokenize(text).map(
      (token) => this.addedTokens.get(token) ?? this.vocab.get(token) ?? this.unkId,
    );
  }

  /** Token strings of `text` (unknown characters stay as themselves). */
  tokenize(text: string): string[] {
    if (this.addedPattern === null) return this.tokenizeSpan(text);
    const out: string[] = [];
    for (const span of text.split(this.addedPattern)) {
      if (span.length === 0) continue;
      if (this.addedTokens.has(span)) out.push(span);
      else out.push(...this.tokenizeSpan(span));
    }
    return out;
  }

  /** Token strings for a sequence of ids; out-of-range ids decode to the unknown token. */
  decode(ids: readonly number[]): string[] {
    return ids.map((id) => this.tokens[id] || this.tokens[this.unkId] || DEFAULT_UNK_TOKEN);
  }

  private tokenizeSpan(text: string): string[] {
    const out: string[] = [];
    for (const word of text.split(/\s+/)) {
      if (word.length > 0) out.push(...this.mergeWord(word));
    }
    return out;
  }

  private mergeWord(word: string): string[] {
    if (this.ignoreMerges && this.vocab.has(word)) return [word];
    const symbols = Array.from(word);
    for (;;) {
      let best = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let i = 0; i + 1 < symbols.length; i++) {
        const rank = this.ranks.get(pairKey(symbols[i]!, symbols[i + 1]!));
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = i;
        }
      }
      if (best < 0) return symbols;
      symbols.splice(best, 2, symbols[best]! + symbols[best + 1]!);
    }
  }
}

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

function splitMerge(merge: string): [string, string] {
  const space = merge.indexOf(' ');
  if (space < 0) throw new Error(`malformed BPE merge: ${JSON.stringify(merge)}`);
  return [merge.slice(0, space), merge.slice(space + 1)];
}

export function loadBpe(json: BpeFile): BpeTokenizer {
  return new BpeTokenizer(json);
}
