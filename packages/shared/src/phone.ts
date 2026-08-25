import * as z from "zod"

interface RegionMeta {
  readonly callingCode: string
  readonly nationalNumberLength: number
  readonly displayGroups: readonly number[]
  readonly example: string
}

export const REGIONS = {
  UZ: { callingCode: '998', nationalNumberLength: 9, displayGroups: [2, 3, 2, 2], example: '+998901234567' },
  US: { callingCode: '1', nationalNumberLength: 10, displayGroups: [3, 3, 4], example: '+12025550123' },
} as const satisfies Record<string, RegionMeta>

export type RegionCode = keyof typeof REGIONS

export const SUPPORTED_REGIONS = ["UZ"] as const satisfies readonly RegionCode[]
export type SupportedRegion = (typeof SUPPORTED_REGIONS)[number]

export const DEFAULT_REGION: SupportedRegion = 'UZ'

export const E164_REGEX = /^\+[1-9]\d{1,14}$/

export const phoneSchema = z.string().regex(E164_REGEX, { error: 'phone.invalid_format' });

export type Phone = z.infer<typeof phoneSchema>

export function createRegionalPhoneSchema(region: SupportedRegion) {
  const { callingCode, nationalNumberLength } = REGIONS[region]
  const expected = 1 + callingCode.length + nationalNumberLength
  return phoneSchema
  .refine((value)=> value.startsWith(`+${callingCode}`), {error:'phone.unsupported_region'})
  .refine((val)=> val.length ===expected, {error:'phone.invalid_length'})
}

const stripSeparators = (raw: string): string => raw.replace(/[\s(\-.)]/g, '')

export function normalizePhone(raw: string, region: SupportedRegion = DEFAULT_REGION):string {
  const {callingCode, nationalNumberLength}= REGIONS[region]
  const cleaned = stripSeparators(raw)
  if(E164_REGEX.test(cleaned)) return cleaned

  const digits = cleaned.replace(/^\+/, '')
  if(!/^\d+$/.test(digits)) return raw

  if(digits.length === callingCode.length + nationalNumberLength && digits.startsWith(callingCode)){
    return `+${digits}`
  }
  
  if(digits.length === nationalNumberLength){
    return `+${callingCode}${digits}`
  }
  return raw
}

export function formatPhone(e164: string, region: SupportedRegion = DEFAULT_REGION): string {
  const { callingCode, displayGroups } = REGIONS[region]
  if (!e164.startsWith(`+${callingCode}`)) return e164

  const national = e164.slice(1 + callingCode.length)
  const parts: string[] = []
  let i = 0
  for (const size of displayGroups) {
    if (i >= national.length) break
    parts.push(national.slice(i, i + size))
    i += size
  }
  if (i < national.length) parts.push(national.slice(i))
  return `+${callingCode} ${parts.join(' ')}`
}