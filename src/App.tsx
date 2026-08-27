import { useEffect, useMemo, useState } from 'react'
import { EMPRESA, money, type Factura } from './portal/mock'

type Screen = 'login' | 'facturas' | 'detalle' | 'pagar'

function pdfApi(codigo: string, nro: string, download = false) {
  const q = new URLSearchParams({ codigo, nro })
  if (download) q.set('dl', '1')
  return `/api/portal/pdf?${q.toString()}`
}

function cobranzasUrl(url?: string | null) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (!/^(?:www\.)?cobranzas\.axoft\.com$/i.test(parsed.hostname)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('login')
  const [codigo, setCodigo] = useState('')
  const [codigoActivo, setCodigoActivo] = useState('')
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState('')
  const [inactivo, setInactivo] = useState(false)
  const [sinComprobantes, setSinComprobantes] = useState(false)
  const [clienteNombre, setClienteNombre] = useState('')
  const [saldoCc, setSaldoCc] = useState(0)
  const [facturas, setFacturas] = useState<Factura[]>([])
  const [elegida, setElegida] = useState<Factura | null>(null)

  const pendientes = useMemo(
    () => facturas.filter((f) => f.estado === 'pendiente'),
    [facturas],
  )

  async function cargarFacturas(code: string) {
    setCargando(true)
    setError('')
    setAviso('')
    setInactivo(false)
    setSinComprobantes(false)
    try {
      const response = await fetch(`/api/portal/facturas?codigo=${encodeURIComponent(code)}`)
      const data = (await response.json()) as {
        cliente?: string
        codigo?: string
        facturas?: Factura[]
        aviso?: string
        error?: string
        saldoCc?: number
        inactivo?: boolean
        sinComprobantes?: boolean
      }
      if (!response.ok) {
        setError(data.error ?? 'No se pudieron leer las facturas.')
        return false
      }
      setClienteNombre(data.cliente?.trim() || code)
      setCodigoActivo(data.codigo?.trim() || code)
      setFacturas(data.facturas ?? [])
      setAviso(data.aviso ?? '')
      setInactivo(Boolean(data.inactivo))
      setSinComprobantes(Boolean(data.sinComprobantes))
      setSaldoCc(typeof data.saldoCc === 'number' ? data.saldoCc : 0)
      return true
    } catch {
      setError('No se pudo conectar con el servidor.')
      return false
    } finally {
      setCargando(false)
    }
  }

  async function ingresar(e: React.FormEvent) {
    e.preventDefault()
    const code = codigo.trim()
    if (!code) {
      setError('Ingresá el código de cliente de Tango.')
      return
    }
    const ok = await cargarFacturas(code)
    if (!ok) return
    setElegida(null)
    setScreen('facturas')
  }

  function salir() {
    setScreen('login')
    setCodigo('')
    setCodigoActivo('')
    setFacturas([])
    setClienteNombre('')
    setSaldoCc(0)
    setError('')
    setAviso('')
    setInactivo(false)
    setSinComprobantes(false)
    setElegida(null)
  }

  function abrir(factura: Factura) {
    setElegida(factura)
    setScreen('detalle')
  }

  function irAPagar(factura: Factura) {
    const url = cobranzasUrl(factura.linkPago)
    if (!url) return
    setElegida(factura)
    setScreen('pagar')
  }

  async function volverDePagar() {
    if (codigoActivo) await cargarFacturas(codigoActivo)
    setScreen('facturas')
  }

  useEffect(() => {
    if (screen !== 'pagar' || !elegida) return
    const url = cobranzasUrl(elegida.linkPago)
    if (!url) return
    let stop = false
    async function consultar() {
      try {
        const response = await fetch(
          `/api/portal/cobro?link=${encodeURIComponent(url)}&fresh=1`,
        )
        const data = (await response.json()) as { procesado?: boolean }
        if (stop || !data.procesado) return
        if (codigoActivo) await cargarFacturas(codigoActivo)
        if (!stop) {
          setElegida(null)
          setScreen('facturas')
        }
      } catch {
        /* se reintenta en el próximo intervalo */
      }
    }
    const id = window.setInterval(() => void consultar(), 4000)
    void consultar()
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [screen, elegida, codigoActivo])

  if (screen === 'login') {
    return (
      <div className="login-shell">
        <form className="card" onSubmit={(e) => void ingresar(e)}>
          <div className="brand-block">
            <p>Portal de clientes</p>
            <h1>{EMPRESA}</h1>
          </div>
          <label className="field">
            <span>Código de cliente</span>
            <input
              autoComplete="username"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="101010"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={cargando}>
            {cargando ? 'Ingresando…' : 'Ingresar'}
          </button>
          <p className="hint">
            Es el código de Tango. Prueba: 17 (Brollo).
          </p>
        </form>
      </div>
    )
  }

  const urlPago = elegida ? cobranzasUrl(elegida.linkPago) : null

  return (
    <div className="portal">
      <header className="top">
        <div>
          <strong>{EMPRESA}</strong>
          <span>
            {codigoActivo} · {clienteNombre}
          </span>
        </div>
        <button className="link" type="button" onClick={salir}>
          Salir
        </button>
      </header>

      {screen === 'pagar' && elegida && urlPago ? (
        <div className="pay-screen">
          <div className="pay-meta">
            <button className="back" type="button" onClick={() => void volverDePagar()}>
              ← Volver
            </button>
            <h2>Pagar factura {elegida.nro}</h2>
            <p>
              Vence {elegida.vencimiento}
              {elegida.saldo > 0 ? ` · ${money(elegida.saldo)}` : ''}
            </p>
            <p className="hint">
              El cobro es de Tango Cobranzas, adentro de Guazu. Si la pantalla queda en
              blanco, el navegador bloqueó el visor; en la app nativa entra igual.
            </p>
          </div>
          <iframe
            className="pay-frame"
            title="Tango Cobranzas"
            src={urlPago}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          />
        </div>
      ) : screen === 'detalle' && elegida ? (
        <div className="pay-screen">
          <div className="pay-meta">
            <button className="back" type="button" onClick={() => setScreen('facturas')}>
              ← Volver
            </button>
            <h2>Factura {elegida.nro}</h2>
            <p>
              Vence {elegida.vencimiento}
              {elegida.saldo > 0 ? ` · ${money(elegida.saldo)}` : ''}
            </p>
            <div className="pdf-actions">
              <a
                className="btn btn-primary"
                href={pdfApi(codigoActivo, elegida.nro, true)}
              >
                Descargar PDF
              </a>
              {urlPago ? (
                <button className="btn btn-accent" type="button" onClick={() => irAPagar(elegida)}>
                  Pagar
                </button>
              ) : null}
            </div>
          </div>
          <iframe
            className="pay-frame"
            title={`Factura ${elegida.nro}`}
            src={pdfApi(codigoActivo, elegida.nro)}
          />
        </div>
      ) : (
      <main className="wrap">
        {screen === 'facturas' && (
          <>
            <div className="hello">
              <h2>Hola, {clienteNombre}</h2>
            </div>
            <p className="section-title">Mis facturas</p>
            {error && <p className="error">{error}</p>}
            {pendientes.length === 0 && (
              <div className="factura-card">
                <h3>
                  {inactivo
                    ? 'Ya no es abonado'
                    : sinComprobantes
                      ? 'Aún no hay comprobantes emitidos'
                      : saldoCc < 2 && saldoCc >= 0
                        ? 'No hay deuda'
                        : 'No hay facturas para pagar'}
                </h3>
                <p className="meta">
                  {aviso ||
                    'El saldo no se cobra solo. Hace falta cada factura con su link de Cobranzas.'}
                </p>
              </div>
            )}
            {facturas.map((f) => {
              const link = cobranzasUrl(f.linkPago)
              return (
                <article className="factura-card" key={f.id}>
                  <header>
                    <div>
                      <h3>
                        {f.nro.startsWith('NC') || f.nro.startsWith('ND')
                          ? f.nro
                          : `Factura ${f.nro}`}
                      </h3>
                      <p className="meta">Vencimiento: {f.vencimiento}</p>
                    </div>
                    <span className={`estado ${f.estado === 'pagada' ? 'ok' : ''}`}>
                      {f.estado === 'pagada' ? 'Pagada' : 'Pendiente'}
                    </span>
                  </header>
                  <div className="monto-block">
                    <small>{f.saldo > 0 ? 'Saldo pendiente' : 'Importe'}</small>
                    <strong>{f.saldo > 0 ? money(f.saldo) : 'Según factura'}</strong>
                  </div>
                  {f.estado === 'pendiente' && (
                    <div className="factura-actions">
                      <button
                        className="btn btn-accent"
                        type="button"
                        disabled={!link}
                        onClick={() => irAPagar(f)}
                      >
                        {link ? 'Pagar' : 'Sin link de cobro'}
                      </button>
                      <button className="btn btn-primary" type="button" onClick={() => abrir(f)}>
                        Ver factura
                      </button>
                      <a className="btn btn-ghost" href={pdfApi(codigoActivo, f.nro, true)}>
                        Descargar
                      </a>
                    </div>
                  )}
                </article>
              )
            })}
            {aviso && pendientes.length > 0 && <p className="sim">{aviso}</p>}
          </>
        )}
      </main>
      )}
    </div>
  )
}
