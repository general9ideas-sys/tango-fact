export type TangoConfig = {
  tangoUrl: string
  companyId: string
  token: string
  codigoCliente: string
  pdfDir: string
  nexoToken: string
  nexoIdCliente: string
}

const KEY = 'guazu.tango.config'

export const emptyConfig = (): TangoConfig => ({
  tangoUrl: 'http://desktop-g7oreki:17000',
  companyId: '3',
  token: '',
  codigoCliente: '101012',
  pdfDir: 'C:\\ProgramData\\Axoft\\052448-001\\Wrk',
  nexoToken: '',
  nexoIdCliente: '',
})

export function loadConfig(): TangoConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyConfig()
    return { ...emptyConfig(), ...JSON.parse(raw) }
  } catch {
    return emptyConfig()
  }
}

export function saveConfig(config: TangoConfig) {
  localStorage.setItem(KEY, JSON.stringify(config))
}
