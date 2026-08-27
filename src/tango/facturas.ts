export type Factura = {
  id: string
  nro: string
  periodo: string
  vencimiento: string
  total: number
  saldo: number
  linkPago: string | null
  clienteNombre: string | null
  origen: 'demo' | 'tango'
  ultimaSync: string | null
}

const STORAGE_KEY = 'guazu.factura.v3'

const BASE: Factura = {
  id: 'pendiente',
  nro: '—',
  periodo: 'Sincronizá un cliente',
  vencimiento: '—',
  total: 0,
  saldo: 0,
  linkPago: null,
  clienteNombre: null,
  origen: 'demo',
  ultimaSync: null,
}

export function loadFactura(): Factura {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...BASE }
    return { ...BASE, ...JSON.parse(raw) }
  } catch {
    return { ...BASE }
  }
}

export function saveFactura(factura: Factura) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(factura))
}

export function money(n: number) {
  return n.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
