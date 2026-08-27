const COBRANZAS = /https?:\/\/cobranzas\.axoft\.com[^\s<>"'\\)\]]*/gi
const NEXO = /https?:\/\/(?:www\.)?nexo\.axoft\.com[^\s<>"'\\)\]]*/gi
const CLIENTES = /https?:\/\/clientes\.axoft\.com[^\s<>"'\\)\]]*/gi

export type LinkKind = 'cobranzas' | 'nexo' | 'clientes' | 'otro'

export function classifyLink(url: string): LinkKind {
  const u = url.trim().toLowerCase()
  if (u.includes('cobranzas.axoft.com')) return 'cobranzas'
  if (u.includes('nexo.axoft.com')) return 'nexo'
  if (u.includes('clientes.axoft.com')) return 'clientes'
  return 'otro'
}

function unescapePdfLiteral(value: string) {
  return value
    .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

function cleanUrl(raw: string): string {
  return unescapePdfLiteral(raw)
    .replace(/[.,;)\]]+$/, '')
    .replace(/\\$/, '')
}

export function extractPaymentLinks(source: string): string[] {
  const found = new Set<string>()
  for (const re of [COBRANZAS, NEXO, CLIENTES]) {
    re.lastIndex = 0
    for (const match of source.matchAll(re)) {
      found.add(cleanUrl(match[0]))
    }
  }
  return [...found]
}

export function extractLinksFromPdfBytes(bytes: Uint8Array): string[] {
  const raw = new TextDecoder('latin1').decode(bytes)
  const fromText = extractPaymentLinks(raw)

  const uriMatches = [
    ...raw.matchAll(/\/URI\s*\(([^)]+)\)/g),
    ...raw.matchAll(/\/URI\s*<([0-9A-Fa-f]+)>/g),
  ]
  const fromUri = uriMatches
    .map((m) => {
      const value = m[1]
      if (/^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0) {
        try {
          return cleanUrl(decodeURIComponent(value.replace(/../g, (h) => `%${h}`)))
        } catch {
          return cleanUrl(value)
        }
      }
      return cleanUrl(value.replace(/\\[()]/g, ''))
    })
    .filter((u) => /axoft\.com/i.test(u) || /^https?:\/\//i.test(u))

  return [...new Set([...fromText, ...fromUri])]
}

export function pdfMentionsCliente(
  bytes: Uint8Array,
  codigo: string,
  razonSocial: string,
): boolean {
  const raw = new TextDecoder('latin1').decode(bytes).toUpperCase()
  if (codigo && raw.includes(codigo.trim().toUpperCase())) return true
  const nombre = razonSocial.replace(/\s+/g, ' ').trim().toUpperCase()
  return nombre.length >= 6 && raw.includes(nombre)
}

export function nroFromFacFileName(fileName: string): string {
  const stem = fileName.replace(/\.pdf$/i, '')
  const m = stem.match(/^FAC([A-Z])(\d{5})(\d+)$/i)
  if (!m) return stem
  return `${m[1].toUpperCase()}${m[2]}-${m[3]}`
}

export async function extractLinksFromPdf(file: File): Promise<string[]> {
  return extractLinksFromPdfBytes(new Uint8Array(await file.arrayBuffer()))
}

export function pickCobranzasLink(links: string[]): string | null {
  return links.find((l) => classifyLink(l) === 'cobranzas') ?? null
}
