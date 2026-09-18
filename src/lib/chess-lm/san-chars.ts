// Character-level tokenizer for numbered SAN text plus the result (`1.e4 e5 2.Nf3 ... 1-0`).
// Mirrors `rukh/src/rukh/tokenize/san_chars.py`: `<pad>`, `<bos>`, `<eos>` first, then the fixed
// 32-symbol alphabet in this exact order; `encode` wraps the text in `<bos>` ... `<eos>`.

export const SAN_ALPHABET = ' #+-.0123456789=BKNOQRabcdefghx/';
export const SAN_SPECIALS: readonly string[] = ['<pad>', '<bos>', '<eos>'];
export const SAN_PAD_ID = 0;
export const SAN_BOS_ID = 1;
export const SAN_EOS_ID = 2;

export class SanCharTokenizer {
  readonly tokens: readonly string[];
  private readonly ids: Map<string, number>;

  constructor(alphabet: string = SAN_ALPHABET, specials: readonly string[] = SAN_SPECIALS) {
    this.tokens = [...specials, ...alphabet];
    this.ids = new Map(this.tokens.map((token, id) => [token, id]));
  }

  get size(): number {
    return this.tokens.length;
  }

  /** `[<bos>, one id per character, <eos>]`; characters outside the alphabet throw. */
  encode(text: string): number[] {
    const ids = Array.from(text, (char) => {
      const id = this.ids.get(char);
      if (id === undefined)
        throw new Error(`character not in SAN alphabet: ${JSON.stringify(char)}`);
      return id;
    });
    return [SAN_BOS_ID, ...ids, SAN_EOS_ID];
  }

  /** Joins the characters back into text; special tokens are dropped. */
  decode(ids: readonly number[]): string {
    return ids
      .map((id) => this.tokens[id] ?? '')
      .filter((token) => !SAN_SPECIALS.includes(token))
      .join('');
  }
}
