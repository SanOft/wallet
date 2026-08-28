import {
  type FieldErrorCode,
  type FieldIssue,
  formatMoney,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TRANSFER_LIMITS,
} from "@wallet/shared"
import type * as z from "zod"

/**
 * One dictionary for both halves of §13.8.2's "single source" rule.
 *
 * The shared schemas put a field code where a message would normally go —
 * `phoneSchema` fails with the literal `"phone.invalid_format"` — and §12.3's
 * error envelope carries the same codes in `details[].code`. So a Zod issue
 * raised on the client and a rejection returned by the server arrive as the
 * same value, and one lookup renders both.
 *
 * That is also why this project uses no form library. A resolver would map the
 * client half and leave the server half to be written separately, in a
 * different shape — two mappings for one vocabulary. Writing it once costs
 * less and cannot drift.
 */

const UZS = TRANSFER_LIMITS.UZS

/**
 * §13.8.2: non-blaming and action-oriented. "The number must be 9 digits",
 * never "Invalid input" — the second tells the user they are wrong without
 * telling them what to do.
 *
 * The amounts are derived rather than written out, so a change to
 * `TRANSFER_LIMITS` cannot leave a message quoting last month's number.
 */
const MESSAGES: Record<FieldErrorCode, string> = {
  "phone.invalid_format": "Raqamni +998 90 123 45 67 ko'rinishida kiriting",
  "phone.unsupported_region": "Hozircha faqat O'zbekiston raqamlari qabul qilinadi",
  "phone.invalid_length": "Raqam 9 ta raqamdan iborat bo'lishi kerak",

  "money.invalid_format": "Summani faqat raqamlar bilan kiriting",
  "money.below_minimum": `Eng kam summa — ${formatMoney(UZS.min, "UZS")}`,
  "money.above_maximum": `Eng ko'p summa — ${formatMoney(UZS.max, "UZS")}`,
  "money.invalid_step": "Summa butun so'm bo'lishi kerak",

  "password.too_short": `Parol kamida ${PASSWORD_MIN_LENGTH} belgidan iborat bo'lsin`,
  "password.too_long": `Parol ${PASSWORD_MAX_LENGTH} belgidan oshmasin`,

  "name.invalid": "Ism harf bilan boshlanib, faqat harflardan iborat bo'lsin",
  "field.required": "Bu maydonni to'ldiring",
  // Reached only when a stored page position no longer parses. The user did
  // nothing wrong, so the message is an instruction rather than a complaint.
  "cursor.invalid": "Ro'yxatni yangilang",

  "limit.per_operation": "Bu summa bitta o'tkazma chegarasidan oshadi",
  "limit.daily": "Bugungi limit tugadi. Ertaga qayta urinib ko'ring",
  "limit.new_recipient": "Yangi qabul qiluvchiga birinchi kunda kamroq yuborish mumkin",
  "limit.velocity": "Juda tez-tez yuboryapsiz. Bir necha daqiqadan so'ng urinib ko'ring",
}

/** Unknown codes render as themselves rather than as an empty space. */
export function messageFor(code: string): string {
  return MESSAGES[code as FieldErrorCode] ?? code
}

/** Field name → message. One message per field: §13.8.2 shows the first fault. */
export type FieldErrors = Readonly<Record<string, string>>

/**
 * A Zod failure, keyed by field.
 *
 * `issue.message` holds the code because that is what the schema was given.
 * The first issue per path wins — a field showing three complaints at once is
 * a field the user stops reading.
 */
export function fromZod(error: z.ZodError): FieldErrors {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = issue.path.join(".")
    if (field && !(field in errors)) errors[field] = messageFor(issue.message)
  }
  return errors
}

/**
 * The server's rejection, keyed the same way.
 *
 * §12.3 puts the code in `details[].code` and the path in `details[].path`, so
 * the only difference from the client half is which property to read.
 */
export function fromApi(details: readonly FieldIssue[] | undefined): FieldErrors {
  const errors: Record<string, string> = {}
  for (const issue of details ?? []) {
    const field = issue.path.join(".")
    if (field && !(field in errors)) errors[field] = messageFor(issue.code)
  }
  return errors
}
