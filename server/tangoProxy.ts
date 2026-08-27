import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import {
  buscarCliente,
  codigosConocidos,
  datosNexo,
  linkCobroFactura,
  nroFacturaClave,
} from './clientesPortal.ts'
import {
  extractLinksFromPdfBytes,
  nroFromFacFileName,
  pdfMentionsCliente,
  pickCobranzasLink,
} from '../src/tango/links.ts'

export type TangoSyncRequest = {
  tangoUrl: string
  companyId: string
  token: string
  codigoCliente: string
  pdfDir?: string
  nexoToken?: string
  nexoIdCliente?: string
}

export type ComprobanteSync = {
  tipo: string
  nro: string
  fecha: string | null
  vencimiento: string | null
  total: number
  estado: string | null
  referencia: string | null
  linkPago: string | null
}

export type TangoSyncResult = {
  cliente: {
    id: number
    codigo: string
    razonSocial: string
    cuit: string | null
    email: string | null
    nexoCobranzasInhabilitado: string | null
  }
  saldoCc: number
  comprobantes: ComprobanteSync[]
  avisos: string[]
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function cleanBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

function assertCodigo(codigo: string) {
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(codigo.trim())) {
    throw new Error('El código de cliente solo puede tener letras, números, punto, guion o guion bajo.')
  }
  return codigo.trim()
}

/** Tango GVA14 suele ir con 6 dígitos (3034 → 003034). */
function variantesCodigoTango(codigo: string) {
  const code = assertCodigo(codigo)
  const out = [code]
  if (/^\d+$/.test(code) && code.length < 6) out.push(code.padStart(6, '0'))
  return [...new Set(out)]
}

function moneyAr(n: number) {
  return `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function tangoGet(params: {
  tangoUrl: string
  companyId: string
  token: string
  path: string
  query: string
}) {
  const url = `${cleanBaseUrl(params.tangoUrl)}/api/${params.path}?${params.query}`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Company: params.companyId.trim(),
      ApiAuthorization: params.token.trim(),
    },
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Tango respondió ${response.status}. Revisá URL (puerto 17000), empresa y token de desarrollador. ${text.slice(0, 240)}`,
    )
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Tango no devolvió JSON. ¿La URL apunta al servidor Delta?')
  }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function pick<T = unknown>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key] as T
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function syncFromDelta(input: TangoSyncRequest): Promise<TangoSyncResult> {
  const codigo = assertCodigo(input.codigoCliente)
  const filtro = `AXV_CLIENTE.COD_GVA14 = '${codigo}'`
  const listJson = await tangoGet({
    tangoUrl: input.tangoUrl,
    companyId: input.companyId,
    token: input.token,
    path: 'GetByFilter',
    query: `process=2117&view=&filtroSql=WHERE%20${encodeURIComponent(filtro)}`,
  })

  const nested = asRecord(listJson.resultData) ?? asRecord(listJson.ResultData)
  const list = (listJson.list ?? listJson.List ?? nested?.list ?? nested?.List) as unknown
  const rows = Array.isArray(list) ? list : []
  if (rows.length === 0) {
    throw new Error(`No hay un cliente con código ${codigo} en esa empresa de Tango.`)
  }

  const row = asRecord(rows[0]) ?? {}
  const id = num(pick(row, ['ID_GVA14', 'idGva14', 'IdGva14']))
  if (!id) throw new Error('Tango devolvió el cliente pero sin ID_GVA14.')

  const detailJson = await tangoGet({
    tangoUrl: input.tangoUrl,
    companyId: input.companyId,
    token: input.token,
    path: 'GetById',
    query: `process=2117&view=&id=${id}`,
  })
  const value = asRecord(detailJson.value) ?? asRecord(detailJson.Value) ?? row
  const saldoCc = num(pick(value, ['SALDO_CC', 'SaldoCc', 'saldo_cc']))

  return {
    cliente: {
      id,
      codigo: str(pick(value, ['COD_GVA14', 'CodGva14'])) ?? codigo,
      razonSocial:
        str(pick(value, ['RAZON_SOCI', 'RazonSoci', 'NOM_COM', 'NomCom'])) ?? codigo,
      cuit: str(pick(value, ['CUIT', 'Cuit'])),
      email: str(pick(value, ['E_MAIL', 'EMail', 'MAIL_NEXO', 'MailNexo'])),
      nexoCobranzasInhabilitado: str(
        pick(value, ['INHABILITADO_NEXO_COBRANZAS', 'InhabilitadoNexoCobranzas']),
      ),
    },
    saldoCc,
    comprobantes: [],
    avisos: [],
  }
}

async function tangoGetPath(params: {
  tangoUrl: string
  companyId: string
  token: string
  pathAndQuery: string
}) {
  const url = `${cleanBaseUrl(params.tangoUrl)}${params.pathAndQuery}`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Company: params.companyId.trim(),
      ApiAuthorization: params.token.trim(),
    },
    signal: AbortSignal.timeout(25000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Tango Live ${response.status}: ${text.slice(0, 240)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('La Live no devolvió JSON.')
  }
}

function collectRows(payload: unknown): Record<string, unknown>[] {
  const rec = asRecord(payload)
  const data = rec ? (asRecord(rec.resultData) ?? rec) : null
  const list = data ? (data.list ?? data.List) : null
  if (Array.isArray(list)) {
    return list.map((x) => asRecord(x) ?? {}).filter((x) => Object.keys(x).length)
  }
  if (Array.isArray(payload)) {
    return payload.map((x) => asRecord(x) ?? {}).filter((x) => Object.keys(x).length)
  }
  return []
}

function liveMeta(payload: unknown) {
  const rec = asRecord(payload)
  const data = rec ? asRecord(rec.resultData) : null
  return {
    totalPages: num(data?.totalPages) || 1,
    totalCount: num(data?.totalCount),
  }
}

function rowMatchesCliente(row: Record<string, unknown>, codigo: string, razon: string) {
  const cod = str(pick(row, ['COD_CLIENTE', 'Cod_Cliente']))
  if (cod) return cod === codigo
  const nombre = str(pick(row, ['RAZON_SOCIAL', 'Razon_Social'])) ?? ''
  return razon.length > 4 && nombre.toUpperCase().includes(razon.toUpperCase())
}

function mapLiveRow(row: Record<string, unknown>): ComprobanteSync {
  return {
    tipo: 'COB',
    nro:
      str(pick(row, ['NRO_DE_RECIBO', 'NRO_OPERACION', 'REFERENCIA'])) ?? 'Solicitud',
    fecha: str(pick(row, ['FECHA_DE_COBRO', 'FECHA_SOLICITUD'])),
    vencimiento: str(pick(row, ['FECHA_SOLICITUD'])),
    total: num(pick(row, ['IMPORTE'])),
    estado: str(pick(row, ['ESTADO'])),
    referencia: str(pick(row, ['REFERENCIA'])),
    linkPago: findLink(row),
  }
}

function findLink(row: Record<string, unknown>): string | null {
  return findLinkDeep(row)
}

function findLinkDeep(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null
  if (typeof value === 'string') {
    const match = value.match(/https?:\/\/(?:www\.)?cobranzas\.axoft\.com[^\s"'<>\\)\]]*/i)
    return match ? match[0] : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findLinkDeep(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const rec = asRecord(value)
  if (!rec) return null
  for (const nested of Object.values(rec)) {
    const hit = findLinkDeep(nested, depth + 1)
    if (hit) return hit
  }
  return null
}

function parseImporteAr(value: string) {
  const t = value.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}

type DatosPrecheckout = { total: number; vencimiento: string | null; procesado: boolean }

function parsePrecheckoutHtml(html: string): DatosPrecheckout | null {
  if (/procesado con anterioridad/i.test(html) || /link de pago ha sido procesado/i.test(html)) {
    return { total: 0, vencimiento: null, procesado: true }
  }
  const totalMatch =
    html.match(/id="totalSingular"[^>]*value="([^"]+)"/i) ??
    html.match(/id="spanImporteAPagar"[^>]*>\s*([^<]+)/i)
  const vencMatch = html.match(/con vencimiento\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)
  const total = totalMatch ? parseImporteAr(totalMatch[1]) : 0
  const vencimiento = vencMatch?.[1] ?? null
  if (!total && !vencimiento) return null
  return { total, vencimiento, procesado: false }
}

const precheckoutCache = new Map<string, { at: number; data: DatosPrecheckout | null }>()
const PRECHECKOUT_TTL_MS = 30_000

async function leerPrecheckout(
  link: string | null | undefined,
  opts?: { fresh?: boolean },
): Promise<DatosPrecheckout | null> {
  if (!link) return null
  let parsed: URL
  try {
    parsed = new URL(link)
  } catch {
    return null
  }
  if (!/^(?:www\.)?cobranzas\.axoft\.com$/i.test(parsed.hostname)) return null
  if (!/precheckout/i.test(parsed.pathname)) return null
  const id = parsed.searchParams.get('id')?.trim() ?? ''
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null
  const key = id.toLowerCase()
  const hit = precheckoutCache.get(key)
  if (!opts?.fresh && hit && Date.now() - hit.at < PRECHECKOUT_TTL_MS) return hit.data
  try {
    const response = await fetch(`https://cobranzas.axoft.com/Precheckout/?id=${encodeURIComponent(id)}`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })
    const html = await response.text()
    const data = response.ok ? parsePrecheckoutHtml(html) : null
    precheckoutCache.set(key, { at: Date.now(), data })
    return data
  } catch {
    precheckoutCache.set(key, { at: Date.now(), data: null })
    return null
  }
}

async function handlePortalCobro(req: IncomingMessage, res: ServerResponse) {
  const reqUrl = new URL(req.url ?? '/', 'http://localhost')
  const link = reqUrl.searchParams.get('link') ?? ''
  const fresh = reqUrl.searchParams.get('fresh') === '1'
  const datos = await leerPrecheckout(link, { fresh })
  sendJson(res, 200, {
    procesado: Boolean(datos?.procesado),
    total: datos?.total ?? 0,
    vencimiento: datos?.vencimiento ?? null,
  })
}

async function rellenarDesdeLink<
  T extends { linkPago?: string | null; saldo: number; vencimiento: string; estado?: string },
>(facturas: T[]): Promise<T[]> {
  return Promise.all(
    facturas.map(async (f) => {
      const datos = await leerPrecheckout(f.linkPago)
      if (!datos) return f
      if (datos.procesado) return { ...f, saldo: 0, estado: 'pagada' }
      return {
        ...f,
        saldo: datos.total > 0 ? datos.total : f.saldo,
        vencimiento: datos.vencimiento ?? f.vencimiento,
      }
    }),
  )
}

function dmy(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

async function syncFromLiveCobranzas(
  input: TangoSyncRequest,
  codigo: string,
  razonSocial: string,
): Promise<{ items: ComprobanteSync[]; aviso: string }> {
  const to = new Date()
  const from = new Date(to.getFullYear(), 0, 1)

  async function page(index: number) {
    const qs = new URLSearchParams({
      process: '13112',
      fromDate: dmy(from),
      toDate: dmy(to),
      pageSize: '80',
      pageIndex: String(index),
      customQuery: '0',
    })
    return tangoGetPath({
      tangoUrl: input.tangoUrl,
      companyId: input.companyId,
      token: input.token,
      pathAndQuery: `/Api/GetApiLiveQueryData?${qs.toString()}`,
    })
  }

  const first = await page(0)
  const rec = asRecord(first)
  if (rec?.succeeded === false || rec?.Succeeded === false) {
    throw new Error(String(rec.message ?? rec.Message ?? 'Live 13112 falló'))
  }

  const rows = collectRows(first)
  const meta = liveMeta(first)
  for (let i = 1; i < Math.min(meta.totalPages, 8); i++) {
    rows.push(...collectRows(await page(i)))
  }

  const delCliente = rows.filter((row) => rowMatchesCliente(row, codigo, razonSocial))
  const items = delCliente.map(mapLiveRow)
  const aviso =
    delCliente.length > 0
      ? `Live Cobranzas: ${delCliente.length} solicitudes de ${codigo} este año (${rows.length} en total). Esta consulta no trae el link de pago.`
      : `Live Cobranzas: ${rows.length} solicitudes en el año, ninguna de ${codigo}. El saldo de la ficha es deuda; esta Live son links ya enviados/cobrados.`

  return { items, aviso }
}

function listPdfFiles(root: string, depth: number, acc: { path: string; mtime: number }[]) {
  if (depth > 6 || acc.length >= 8000) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (acc.length >= 8000) return
    const full = join(root, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) listPdfFiles(full, depth + 1, acc)
    else if (st.isFile() && extname(name).toLowerCase() === '.pdf') {
      acc.push({ path: full, mtime: st.mtimeMs })
    }
  }
}

function carpetasPdfDelCliente(root: string, codigo: string) {
  if (!codigo.trim()) return [root]
  const candidatos = new Set<string>()
  for (const variant of variantesCodigoTango(codigo)) {
    candidatos.add(join(root, variant))
    if (/^\d+$/.test(variant)) candidatos.add(join(root, variant.padStart(6, '0')))
  }
  const halladas = [...candidatos].filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
  return halladas
}

function estaDentroDeCarpeta(raiz: string, archivo: string) {
  const root = resolve(raiz).toLowerCase()
  const full = resolve(archivo).toLowerCase()
  return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep)
}

function hallarPdfFactura(codigo: string, nro: string): string | null {
  const dir = tangoPdfDir()
  if (!dir) return null
  const root = resolve(dir)
  const clave = nroFacturaClave(nro)
  if (!clave) return null
  const files: { path: string; mtime: number }[] = []
  for (const carpeta of carpetasPdfDelCliente(root, codigo)) {
    if (!estaDentroDeCarpeta(root, carpeta)) continue
    listPdfFiles(carpeta, 0, files)
  }
  const hits = files
    .filter((f) => {
      if (!estaDentroDeCarpeta(root, f.path)) return false
      if (!/^FAC/i.test(basename(f.path))) return false
      return nroFacturaClave(nroFromFacFileName(basename(f.path))) === clave
    })
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0]?.path ?? null
}

function handlePortalPdf(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const codigo = (url.searchParams.get('codigo') ?? '').trim()
  const nro = (url.searchParams.get('nro') ?? '').trim()
  const download = url.searchParams.get('dl') === '1'
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(codigo) || !/^[A-Za-z0-9-]{4,40}$/.test(nro)) {
    sendJson(res, 400, { error: 'Código o número de factura inválido.' })
    return
  }
  const file = hallarPdfFactura(codigo, nro)
  if (!file) {
    sendJson(res, 404, { error: 'No está el PDF de esa factura.' })
    return
  }
  const filename = `Factura-${nroFacturaClave(nro)}.pdf`
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
  )
  const stream = createReadStream(file)
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'No se pudo leer el PDF.' })
    else res.end()
  })
  stream.pipe(res)
}

function esPdfConCobro(filePath: string) {
  const base = (filePath.split(/[/\\]/).pop() ?? '').replace(/\.pdf$/i, '')
  return /^(FAC|DAJ)/i.test(base)
}

function nroFromPath(filePath: string) {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return nroFromFacFileName(base)
}

function fechaAfipAr(yyyymmdd: string) {
  const m = yyyymmdd.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return yyyymmdd
  return `${m[3]}/${m[2]}/${m[1]}`
}

const PLAZO_LINK_DIAS = 40

function parseAfipAlLadoDelPdf(pdfPath: string): { fecha: string | null; total: number } {
  const stem = basename(pdfPath).replace(/\.pdf$/i, '')
  const candidatos = [
    join(dirname(pdfPath), `${stem}AFIP.XML`),
    join(dirname(pdfPath), `${stem}AFIP.xml`),
  ]
  for (const xmlPath of candidatos) {
    let xml: string
    try {
      xml = readFileSync(xmlPath, 'utf8')
    } catch {
      continue
    }
    const fecha = xml.match(/name="CbteFch"[^>]*>\s*(\d{8})/i)?.[1] ?? null
    const bruto =
      xml.match(/name="ImpTotal"[^>]*>\s*([^<]+)/i)?.[1] ??
      xml.match(/<ImpTotal>\s*([^<]+)/i)?.[1] ??
      ''
    const total = Number(bruto.trim().replace(',', '.'))
    return { fecha, total: Number.isFinite(total) ? total : 0 }
  }
  return { fecha: null, total: 0 }
}

function diasDesdeEmision(yyyymmdd: string | null) {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null
  const emitida = new Date(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  )
  if (Number.isNaN(emitida.getTime())) return null
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  emitida.setHours(0, 0, 0, 0)
  return Math.round((hoy.getTime() - emitida.getTime()) / 86_400_000)
}

function linkVigentePorEmision(yyyymmdd: string | null, mtimeMs?: number) {
  const dias = diasDesdeEmision(yyyymmdd)
  if (dias != null) return dias >= 0 && dias <= PLAZO_LINK_DIAS
  if (mtimeMs == null) return false
  const porArchivo = Math.round((Date.now() - mtimeMs) / 86_400_000)
  return porArchivo >= 0 && porArchivo <= PLAZO_LINK_DIAS
}

function aniosDesdeEmision(yyyymmdd: string | null) {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null
  const emitida = new Date(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  )
  if (Number.isNaN(emitida.getTime())) return null
  return (Date.now() - emitida.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
}

function facturasAAbonar(
  pdfDir: string | undefined,
  codigo: string,
  razonSocial: string,
): { items: ComprobanteSync[]; aviso: string; ultimaFecha: string | null } {
  const all = syncFromLocalPdfs(pdfDir, codigo, razonSocial)
  const facs = all.items.filter((i) => i.tipo === 'FAC' && i.linkPago)
  const ultimaFecha = facs[0]?.fecha ?? null
  if (facs.length === 0) {
    return {
      items: [],
      ultimaFecha: null,
      aviso:
        'Todavía no hay comprobantes emitidos. Cuando Tango facture, van a aparecer acá.',
    }
  }
  const vistos = new Set<string>()
  const items = facs
    .filter((i) => linkVigentePorEmision(i.fecha))
    .filter((i) => {
      const key = nroFacturaClave(i.nro) || i.nro
      if (vistos.has(key)) return false
      vistos.add(key)
      return true
    })
    .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? ''))
  if (items.length === 0) {
    const ultima = ultimaFecha ? fechaAfipAr(ultimaFecha) : null
    return {
      items: [],
      ultimaFecha,
      aviso: ultima
        ? `La última factura es del ${ultima}. El link de cobro vale 40 días desde la emisión.`
        : all.aviso,
    }
  }
  const fechas = items
    .map((i) => (i.fecha ? fechaAfipAr(i.fecha) : null))
    .filter(Boolean)
    .join(', ')
  return {
    items,
    ultimaFecha,
    aviso:
      items.length > 1
        ? `A pagar: ${items.length} facturas con link vigente (${fechas}). Cada una se paga aparte.`
        : fechas
          ? `A pagar: factura del ${fechas}.`
          : all.aviso,
  }
}

function syncFromLocalPdfs(
  pdfDir: string | undefined,
  codigo: string,
  razonSocial: string,
): { items: ComprobanteSync[]; aviso: string } {
  const rawDir = pdfDir?.trim()
  if (!rawDir) {
    return {
      items: [],
      aviso:
        'Sin carpeta de PDFs: Tango no entrega el link por API. Hay que leer el PDF de ese cliente (@WP).',
    }
  }

  const root = resolve(rawDir)
  if (!root || root.includes(`..${sep}`)) {
    return { items: [], aviso: 'La carpeta de PDFs no es válida.' }
  }

  const files: { path: string; mtime: number }[] = []
  if (!codigo.trim()) {
    return {
      items: [],
      aviso:
        'Hay que buscar por código de cliente. No se recorre toda la carpeta COMPROBANTES.',
    }
  }
  const scanRoots = carpetasPdfDelCliente(root, codigo)
  if (codigo.trim() && scanRoots.length === 0) {
    return {
      items: [],
      aviso:
        'Todavía no hay comprobantes emitidos. Cuando Tango facture, van a aparecer acá.',
    }
  }
  const acotadoAlCliente = Boolean(codigo.trim()) && !scanRoots.includes(root)
  for (const dir of scanRoots) {
    listPdfFiles(dir, 0, files)
  }
  if (files.length === 0) {
    return {
      items: [],
      aviso: codigo.trim()
        ? 'Todavía no hay comprobantes emitidos. Cuando Tango facture, van a aparecer acá.'
        : `No se pudo leer la carpeta de PDFs (${root}). Tiene que ser la PC de Tango o una carpeta compartida. Tango guarda ahí FAC….pdf al emitir/imprimir.`,
    }
  }

  files.sort((a, b) => b.mtime - a.mtime)
  const items: ComprobanteSync[] = []
  const codigoUpper = codigo.toUpperCase()
  const codigoPad = /^\d+$/.test(codigo) ? codigo.padStart(6, '0').toUpperCase() : codigoUpper

  for (const file of files) {
    if (!esPdfConCobro(file.path)) continue
    const afip = parseAfipAlLadoDelPdf(file.path)
    if (!linkVigentePorEmision(afip.fecha, file.mtime)) continue
    const parts = file.path.toUpperCase().split(/[/\\]/)
    const inClientFolder =
      acotadoAlCliente || parts.includes(codigoUpper) || parts.includes(codigoPad)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(file.path))
    } catch {
      continue
    }
    if (
      (codigo || razonSocial) &&
      !inClientFolder &&
      !pdfMentionsCliente(bytes, codigo, razonSocial)
    ) {
      continue
    }
    const link = pickCobranzasLink(extractLinksFromPdfBytes(bytes))
    const fecha = afip.fecha
    const tipo = /^FAC/i.test(basename(file.path)) ? 'FAC' : 'DAJ'
    items.push({
      tipo,
      nro: nroFromPath(file.path),
      fecha,
      vencimiento: fecha ? fechaAfipAr(fecha) : null,
      total: afip.total,
      estado: 'Pendiente',
      referencia: 'PDF Tango',
      linkPago: link,
    })
  }

  const conLink = items.filter((i) => i.linkPago).length
  const aviso =
    items.length > 0
      ? `PDFs de ${codigo}: ${items.length} factura(s) en la carpeta, ${conLink} con link de Cobranzas.`
      : `Hay ${files.length} PDF(s) en la carpeta, ninguno nombra al cliente ${codigo}. Abrí/imprimí su factura en Tango para que se genere el FAC….pdf.`

  return { items, aviso }
}

function tangoPdfDir() {
  return (process.env.TANGO_PDF_DIR ?? '').trim()
}

function indexPdfsPorNro(codigo: string) {
  const dir = tangoPdfDir()
  const map = new Map<string, ComprobanteSync>()
  const code = codigo.trim()
  if (!dir || !code) return map
  const cacheKey = `${dir}::${code}`
  if (pdfIndexCache?.key === cacheKey) return pdfIndexCache.map
  const fromPdf = syncFromLocalPdfs(dir, code, '')
  for (const item of fromPdf.items) {
    const key = nroFacturaClave(item.nro)
    if (key && item.linkPago) map.set(key, item)
  }
  pdfIndexCache = { key: cacheKey, map }
  return map
}

let pdfIndexCache: { key: string; map: Map<string, ComprobanteSync> } | null = null

function loadDotEnvLocal() {
  try {
    const text = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
  } catch {
    /* sin .env.local */
  }
}

loadDotEnvLocal()

function nexoTokens() {
  const keys = ['NEXO_TOKEN', 'NEXO_TOKEN_ALT']
  const out: string[] = []
  for (const key of keys) {
    const value = (process.env[key] ?? '').trim().replace(/^["']|["']$/g, '')
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

function nexoToken() {
  return nexoTokens()[0] ?? ''
}

function nexoClientIds(preferred?: string) {
  const fromEnv = (process.env.NEXO_CLIENT_ID ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const ids = [preferred?.trim(), ...fromEnv].filter(Boolean) as string[]
  return [...new Set(ids)]
}

function fechaAr(value: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('es-AR')
}

async function fetchNexoDocs(token: string, id: string) {
  const from = new Date()
  from.setFullYear(from.getFullYear() - 1)
  const fromStr = from.toISOString().slice(0, 10)
  const attempts: { From?: string }[] = [{ From: fromStr }, {}]
  let lastError = 'Nexo no respondió.'
  for (const extra of attempts) {
    const headers: Record<string, string> = {
      Token: token,
      Accept: 'application/json',
      ...extra,
    }
    const response = await fetch(
      `https://clientes.axoft.com/api/comprobantes/getjsonfrom/${encodeURIComponent(id)}`,
      {
        headers,
        signal: AbortSignal.timeout(20000),
      },
    )
    const text = await response.text()
    if (!response.ok) {
      const detalle = text.replace(/\s+/g, ' ').trim().slice(0, 180)
      lastError = `Nexo Clientes respondió ${response.status} para el id ${id}${detalle ? `: ${detalle}` : '.'}`
      continue
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('Nexo no devolvió JSON. ¿El servicio quedó habilitado?')
    }
    const wrapped = asRecord(payload)
    const list = Array.isArray(payload)
      ? payload
      : wrapped
        ? wrapped.comprobantes ?? wrapped.Comprobantes ?? wrapped.data ?? wrapped.Data
        : null
    if (Array.isArray(list)) return list
    if (payload && asRecord(payload)?.InformacionComprobante) return [payload]
    return []
  }
  throw new Error(lastError)
}

function mapNexoDoc(doc: unknown): ComprobanteSync & { cliente: string | null } {
  const rec = asRecord(doc) ?? {}
  const info = asRecord(rec.InformacionComprobante) ?? rec
  const totales = asRecord(rec.Totales)
  const comprador = asRecord(rec.InformacionComprador)
  const ext = asRecord(rec.Extensiones)
  const medios = asRecord(ext?.ExtensionMediosDePago)
  const vencimientos = Array.isArray(medios?.Vencimientos) ? medios.Vencimientos : []
  const primero = asRecord(vencimientos[0])
  const nro = str(info.NumeroDeComprobante) ?? '—'
  const cuota = num(primero?.ImporteCuota)
  const total = num(totales?.ImporteTotalFactura)
  return {
    tipo: str(info.TipoDeComprobante) ?? 'FAC',
    nro,
    fecha: str(info.FechaDeEmision),
    vencimiento: fechaAr(str(primero?.FechaVencimiento) ?? str(info.FechaDeEmision)),
    total: cuota || total,
    estado: null,
    referencia: null,
    linkPago: findLinkDeep(doc) ?? linkCobroFactura(nro),
    cliente: str(comprador?.Denominacion),
  }
}

async function syncFromNexo(input: TangoSyncRequest): Promise<ComprobanteSync[]> {
  const token = input.nexoToken?.trim() || nexoToken()
  if (!token) return []
  const ids = nexoClientIds(input.nexoIdCliente)
  let lastError = 'Falta el id de cliente de Nexo.'
  for (const id of ids) {
    try {
      const docs = await fetchNexoDocs(token, id)
      return docs.map((doc) => {
        const mapped = mapNexoDoc(doc)
        const { cliente: _cliente, ...rest } = mapped
        return rest
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Nexo no respondió.'
    }
  }
  throw new Error(lastError)
}

async function resolverClientePortal(codigo: string) {
  const code = codigo.trim()
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(code)) return null
  const variantes = variantesCodigoTango(code)
  const local = variantes.map(buscarCliente).find(Boolean) ?? null
  const tangoToken = (process.env.TANGO_TOKEN ?? '').trim()
  if (tangoToken) {
    for (const variant of variantes) {
      try {
        const delta = await syncFromDelta({
          tangoUrl: process.env.TANGO_URL || 'http://desktop-g7oreki:17000',
          companyId: process.env.TANGO_COMPANY || '3',
          token: tangoToken,
          codigoCliente: variant,
        })
        const nexo = datosNexo(delta.cliente.codigo).nexoId
          ? datosNexo(delta.cliente.codigo)
          : datosNexo(code)
        return {
          codigo: delta.cliente.codigo,
          nombre: delta.cliente.razonSocial,
          nexoId: nexo.nexoId,
          token: nexo.token,
          tokens: nexo.tokens,
          saldoCc: delta.saldoCc,
        }
      } catch {
        continue
      }
    }
    return local ? { ...local, saldoCc: 0 } : null
  }
  return local ? { ...local, saldoCc: 0 } : null
}

async function handlePortalFacturas(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const codigo = (url.searchParams.get('codigo') ?? '').trim()
  const cliente = await resolverClientePortal(codigo)
  if (!cliente) {
    sendJson(res, 404, {
      error: 'Ese código no está en Tango. Probá 101010, 101012, 101013 o 101014.',
    })
    return
  }

  if (cliente.nexoId && !tangoPdfDir()) {
    const tokens = [...cliente.tokens, ...nexoTokens()].filter((t, i, arr) => t && arr.indexOf(t) === i)
    if (tokens.length === 0) {
      sendJson(res, 500, {
        error: 'Falta NEXO_TOKEN en .env.local.',
      })
      return
    }
    const intentos: string[] = []
    let lastError = 'Nexo no devolvió comprobantes.'
    for (const token of tokens) {
      try {
        const docs = await fetchNexoDocs(token, cliente.nexoId)
        const pdfs = indexPdfsPorNro(cliente.codigo)
        const facturas = await rellenarDesdeLink(
          docs
            .map((doc) => mapNexoDoc(doc))
            .filter((f) => f.nro !== '—')
            .map((f) => {
              const pdf = pdfs.get(nroFacturaClave(f.nro))
              return {
                id: f.nro,
                nro: f.nro,
                vencimiento: f.vencimiento ?? '—',
                saldo: f.total,
                estado: 'pendiente' as const,
                cliente: f.cliente ?? cliente.nombre,
                linkPago: f.linkPago ?? pdf?.linkPago ?? null,
              }
            }),
        )
        const conLink = facturas.filter((f) => f.linkPago).length
        sendJson(res, 200, {
          cliente: cliente.nombre,
          codigo: cliente.codigo,
          origen: 'nexo',
          saldoCc: cliente.saldoCc ?? 0,
          facturas,
          aviso:
            facturas.length === 0
              ? `Nexo no tiene comprobantes electrónicos de ${cliente.nombre} en el último año.`
              : conLink === 0
                ? `Estas son las facturas electrónicas. El pago se hace con el link de Cobranzas de cada PDF (@WP), no con el saldo.`
                : `Facturas de ${cliente.nombre}. Pagar abre el link de esa factura.`,
        })
        return
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Nexo no respondió.'
        intentos.push(lastError)
      }
    }
    sendJson(res, 502, {
      error: lastError,
      intentos,
      cliente: cliente.nombre,
      aviso: `El código ${cliente.codigo} es ${cliente.nombre}, pero Nexo no entregó las facturas.`,
    })
    return
  }

  const fromPdf = tangoPdfDir()
    ? facturasAAbonar(tangoPdfDir(), cliente.codigo, cliente.nombre)
    : { items: [], aviso: '', ultimaFecha: null as string | null }
  const facturas = (
    await rellenarDesdeLink(
      fromPdf.items.map((i) => ({
        id: nroFacturaClave(i.nro) || i.nro,
        nro: i.nro,
        vencimiento: i.vencimiento ?? 'Según PDF',
        saldo: i.total,
        estado: 'pendiente' as const,
        cliente: cliente.nombre,
        linkPago: i.linkPago,
      })),
    )
  ).filter((f) => f.estado !== 'pagada' && Boolean(f.linkPago))
  const saldo = cliente.saldoCc ?? 0
  const primera = facturas[0]
  const aniosSinFactura = aniosDesdeEmision(fromPdf.ultimaFecha)
  const inactivo =
    facturas.length === 0 &&
    aniosSinFactura != null &&
    aniosSinFactura >= 2 &&
    Math.abs(saldo) < 2
  const sinComprobantes =
    facturas.length === 0 && !inactivo && !fromPdf.ultimaFecha && Math.abs(saldo) < 2
  const aviso = inactivo
    ? `Este código ya no es abonado. La última factura es del ${fechaAfipAr(fromPdf.ultimaFecha ?? '')}.`
    : facturas.length > 1
      ? `${facturas.length} facturas con link vigente (40 días desde la emisión). Cada una se paga aparte.`
      : primera && primera.saldo > 0
        ? `Vence el ${primera.vencimiento} · ${moneyAr(primera.saldo)} (dato de Cobranzas).`
      : sinComprobantes
        ? 'Todavía no hay comprobantes emitidos. Cuando Tango facture, van a aparecer acá.'
        : fromPdf.items.length === 0 && fromPdf.aviso
          ? fromPdf.aviso
          : saldo >= 2
            ? `Hay ${moneyAr(saldo)} de saldo en Tango. No hay facturas con link vigente (40 días desde la emisión).`
            : saldo > 0
              ? `En Tango el saldo vencido es ${moneyAr(saldo)}. No hay facturas con link vigente para mostrar.`
              : saldo < 0
                ? `Entraste como ${cliente.nombre} (${cliente.codigo}). En Tango hay saldo a favor de ${moneyAr(Math.abs(saldo))}.`
                : `Entraste como ${cliente.nombre} (${cliente.codigo}). En Tango no hay deuda.`
  sendJson(res, 200, {
    cliente: cliente.nombre,
    codigo: cliente.codigo,
    origen: facturas.length ? 'pdf' : 'tango',
    saldoCc: saldo,
    facturas,
    inactivo,
    sinComprobantes,
    aviso,
  })
}

export async function handleTangoApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? ''
  const path = url.split('?')[0]
  if (path === '/api/portal/health') {
    sendJson(res, 200, {
      hasToken: Boolean(nexoToken()),
      clientes: codigosConocidos(),
    })
    return true
  }
  if (path === '/api/portal/cobro') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Usá GET' })
      return true
    }
    try {
      await handlePortalCobro(req, res)
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : 'No se pudo leer Cobranzas.',
      })
    }
    return true
  }
  if (path === '/api/portal/pdf') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Usá GET' })
      return true
    }
    try {
      handlePortalPdf(req, res)
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : 'No se pudo abrir el PDF.',
      })
    }
    return true
  }
  if (path === '/api/portal/facturas') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Usá GET' })
      return true
    }
    try {
      await handlePortalFacturas(req, res)
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : 'Error al consultar Nexo.',
      })
    }
    return true
  }
  if (!url.startsWith('/api/tango')) return false

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Usá POST' })
    return true
  }

  try {
    const input = JSON.parse(await readBody(req)) as TangoSyncRequest
    if (!input.tangoUrl || !input.companyId || !input.token || !input.codigoCliente) {
      sendJson(res, 400, {
        error: 'Faltan URL de Tango, empresa, token o código de cliente.',
      })
      return true
    }

    const result = await syncFromDelta(input)
    const fromPdf = syncFromLocalPdfs(
      input.pdfDir,
      result.cliente.codigo,
      result.cliente.razonSocial,
    )
    result.comprobantes = fromPdf.items
    result.avisos.push(fromPdf.aviso)

    try {
      const live = await syncFromLiveCobranzas(
        input,
        result.cliente.codigo,
        result.cliente.razonSocial,
      )
      if (result.comprobantes.length === 0) result.comprobantes = live.items
      result.avisos.push(live.aviso)
    } catch (err) {
      result.avisos.push(
        err instanceof Error ? err.message : 'No se pudo leer Live de Cobranzas (13112).',
      )
    }
    try {
      const nexo = await syncFromNexo(input)
      if (nexo.length && result.comprobantes.length === 0) result.comprobantes = nexo
    } catch (err) {
      result.avisos.push(err instanceof Error ? err.message : 'No se pudieron leer comprobantes de Nexo.')
    }

    if (result.comprobantes.length === 0) {
      result.avisos.push(
        'El saldo es de Tango. La factura y el link de Cobranzas se leen del PDF de ese código de cliente, no de un link fijo.',
      )
    }
    if (result.cliente.nexoCobranzasInhabilitado === 'S') {
      result.avisos.push('Este cliente tiene deshabilitado Nexo Cobranzas en Tango.')
    }

    sendJson(res, 200, result)
  } catch (err) {
    sendJson(res, 400, {
      error: err instanceof Error ? err.message : 'Error al hablar con Tango',
    })
  }
  return true
}
