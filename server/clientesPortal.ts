export type ClientePortal = {
  codigo: string
  nombre: string
  nexoId: string
  token: string
  tokens: string[]
  saldoCc?: number
}

const NOMBRES: Record<string, string> = {
  '101010': 'CHRAUST NICOLAS ANDRES',
  '101012': 'CORTESE JOSE',
  '101013': 'MARTINEZ SALAS EVELIN',
  '101014': 'RAMIREZ ROMINA BELEN',
}

function nexoMap(): Record<string, string> {
  const raw = process.env.NEXO_MAP ?? ''
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const [codigo, nexoId] = part.split(':').map((x) => x.trim())
    if (codigo && nexoId) out[codigo] = nexoId
  }
  const fallback = process.env.NEXO_CLIENT_ID?.trim()
  if (fallback && !out['101010']) out['101010'] = fallback
  return out
}

function tokensDeCodigo(codigo: string) {
  const keys = [`NEXO_TOKEN_${codigo}`, `NEXO_TOKEN_${codigo}_ALT`, 'NEXO_TOKEN']
  const out: string[] = []
  for (const key of keys) {
    const value = (process.env[key] ?? '').trim().replace(/^["']|["']$/g, '')
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

function tokenDeCodigo(codigo: string) {
  return tokensDeCodigo(codigo)[0] ?? ''
}

export function datosNexo(codigo: string) {
  return {
    nexoId: nexoMap()[codigo] ?? '',
    token: tokenDeCodigo(codigo),
    tokens: tokensDeCodigo(codigo),
  }
}

export function buscarCliente(codigo: string): ClientePortal | null {
  const code = codigo.trim()
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(code)) return null
  const nombre = NOMBRES[code]
  const nexo = datosNexo(code)
  if (!nombre && !nexo.nexoId) return null
  return {
    codigo: code,
    nombre: nombre ?? code,
    nexoId: nexo.nexoId,
    token: nexo.token,
    tokens: nexo.tokens,
  }
}

export function nroFacturaClave(nro: string) {
  return nro.replace(/[-\s]/g, '').toUpperCase()
}

/** Links de Cobranzas ya armados (Precheckout). El JSON de Nexo no los trae. */
const LINKS_COBRO: Record<string, string> = {
  B0000500005816:
    'https://cobranzas.axoft.com/Precheckout/?id=05183904-f8c0-47eb-aa29-a1c532b3dcbc',
}

export function linkCobroFactura(nro: string): string | null {
  const key = nroFacturaClave(nro)
  const fromEnv = process.env.PAY_LINKS ?? ''
  for (const part of fromEnv.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const n = nroFacturaClave(part.slice(0, eq))
    const id = part.slice(eq + 1).trim()
    if (n === key && id) {
      return id.startsWith('http') ? id : `https://cobranzas.axoft.com/Precheckout/?id=${id}`
    }
  }
  return LINKS_COBRO[key] ?? null
}

export function codigosConocidos() {
  return Object.keys(NOMBRES)
}
