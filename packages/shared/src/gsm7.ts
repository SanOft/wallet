/**
 * Making a string safe to put on a USSD channel.
 *
 * The rule this file enforces is easy to state and easy to miss: a USSD
 * response fits 182 characters *only* while every one of them is in the GSM
 * 7-bit default alphabet (3GPP TS 23.038). A single character outside it —
 * the turned comma in "Gʻafur", any Cyrillic letter in "Иван" — switches the
 * whole string to UCS-2, and the limit becomes 70. The message is then
 * truncated by the network, silently, somewhere in the middle of a recipient's
 * name on a confirmation screen.
 *
 * `nameSchema` accepts both of those spellings on purpose (it cites them by
 * name), so this is not a hypothetical: it is the ordinary case for this
 * product's users.
 *
 * Unrepresentable characters become `?` rather than being dropped. Dropping
 * produces a different, plausible-looking name, and the whole point of showing
 * the recipient before the PIN is that the sender can tell whether it is the
 * right person.
 */

/**
 * The printable half of the default alphabet, in code order from 0x20.
 *
 * The control positions — 0x0A line feed, 0x0D carriage return, 0x1B escape —
 * are added separately below rather than embedded here, because a literal
 * control character inside a source string is invisible to every reviewer who
 * looks at this file.
 */
const PRINTABLE_LOW = " !\"#¤%&'()*+,-./0123456789:;<=>?"
const PRINTABLE_HIGH = "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

/** 0x00–0x1F, minus the three control codes. */
const NATIONAL = "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ"

/** Two septets each: an escape, then the code below. */
const EXTENDED = "^{}\\[~]|€"

const BASIC_SET = new Set([...NATIONAL, ...PRINTABLE_LOW, ...PRINTABLE_HIGH, "\n", "\r"])
const EXTENDED_SET = new Set([...EXTENDED])

/**
 * What the alphabet cannot hold, spelled the way an Uzbek keyboard produces it.
 *
 * Three kinds of entry, and each earns its place:
 *
 *  - the four apostrophes Unicode offers for `o'` and `g'`, which `nameSchema`
 *    all accept, collapsed onto the one ASCII apostrophe the alphabet has;
 *  - Uzbek and Russian Cyrillic, transliterated rather than replaced, because
 *    "IVAN I." is a name the sender can recognise and "???? ?." is not;
 *  - the typographic punctuation that arrives by copy-paste.
 *
 * Lowercase is derived from the uppercase entries, so each letter is stated
 * once and the two cases cannot drift apart.
 */
const TRANSLITERATIONS: ReadonlyArray<readonly [string, string]> = [
  ["‘", "'"],
  ["’", "'"],
  ["ʻ", "'"],
  ["ʼ", "'"],
  ["‛", "'"],
  ["“", '"'],
  ["”", '"'],
  ["–", "-"],
  ["—", "-"],
  ["…", "..."],
  ["А", "A"],
  ["Б", "B"],
  ["В", "V"],
  ["Г", "G"],
  ["Ғ", "G'"],
  ["Д", "D"],
  ["Е", "E"],
  ["Ё", "YO"],
  ["Ж", "J"],
  ["З", "Z"],
  ["И", "I"],
  ["Й", "Y"],
  ["К", "K"],
  ["Қ", "Q"],
  ["Л", "L"],
  ["М", "M"],
  ["Н", "N"],
  ["О", "O"],
  ["П", "P"],
  ["Р", "R"],
  ["С", "S"],
  ["Т", "T"],
  ["У", "U"],
  ["Ў", "O'"],
  ["Ф", "F"],
  ["Х", "X"],
  ["Ҳ", "H"],
  ["Ц", "TS"],
  ["Ч", "CH"],
  ["Ш", "SH"],
  ["Щ", "SHCH"],
  ["Ъ", "'"],
  ["Ы", "I"],
  ["Ь", ""],
  ["Э", "E"],
  ["Ю", "YU"],
  ["Я", "YA"],
]

const MAP: ReadonlyMap<string, string> = new Map([
  ...TRANSLITERATIONS,
  ...TRANSLITERATIONS.map(
    ([from, to]) => [from.toLowerCase(), to.toLowerCase()] as readonly [string, string],
  ),
])

/**
 * Every character that survives this is one the alphabet can carry.
 *
 * Iterated by code point, not by code unit: a surname starting above the BMP
 * would otherwise be split into unpaired surrogates and produce two `?` where
 * the user typed one letter.
 */
export function toGsm7(text: string): string {
  let out = ""
  for (const char of text) {
    if (BASIC_SET.has(char) || EXTENDED_SET.has(char)) {
      out += char
      continue
    }
    out += MAP.get(char) ?? "?"
  }
  return out
}

/**
 * The septet count, which is what the 182 budget is actually measured in.
 *
 * `text.length` is not it: `[` and the euro sign cost two septets each because
 * they are reached through the escape. A message of 182 square brackets is 364
 * septets and arrives cut in half.
 *
 * Returns `null` for a string that is not representable at all, so a caller
 * cannot mistake "cannot be measured" for "measured as zero".
 */
export function gsm7Septets(text: string): number | null {
  let septets = 0
  for (const char of text) {
    if (BASIC_SET.has(char)) septets += 1
    else if (EXTENDED_SET.has(char)) septets += 2
    else return null
  }
  return septets
}
