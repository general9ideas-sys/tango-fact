export type Factura = {
  id: string
  nro: string
  vencimiento: string
  saldo: number
  estado: 'pendiente' | 'pagada'
  cliente?: string | null
  linkPago?: string | null
}

export type Cliente = {
  nombre: string
  email: string
  cuit: string
}

export type Pago = {
  facturaId: string
  nro: string
  importe: number
  medio: MedioPago
  operacion: string
}

export type MedioPago = 'tarjeta' | 'transferencia' | 'dinero'

export const EMPRESA = 'Guazu Seguridad'

export const CLIENTE_DEMO: Cliente = {
  nombre: 'Juan',
  email: 'cliente@empresa.com',
  cuit: '20123456789',
}

export const CLAVE_DEMO = 'demo'

export function facturasIniciales(): Factura[] {
  return [
    {
      id: 'fac-1',
      nro: 'B00004-00005244',
      vencimiento: '30/08/2026',
      saldo: 150000,
      estado: 'pendiente',
    },
    {
      id: 'fac-2',
      nro: 'B00004-00005249',
      vencimiento: '15/09/2026',
      saldo: 80000,
      estado: 'pendiente',
    },
  ]
}

export function money(n: number) {
  return n.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 2,
  })
}

export function nroOperacion() {
  const n = Math.random().toString(36).slice(2, 10).toUpperCase()
  return `MP-${n}`
}

export function loginValido(usuario: string, clave: string) {
  const u = usuario.trim().toLowerCase().replace(/-/g, '')
  const okUser =
    u === CLIENTE_DEMO.email || u === CLIENTE_DEMO.cuit || u === '20-12345678-9'
  return okUser && clave === CLAVE_DEMO
}
