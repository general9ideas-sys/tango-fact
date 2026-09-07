# API Facturas Guazu

Backend de facturas para la app Guazu. **No** se conecta a la base SQL de Tango.
Lee Tango (API), la carpeta `COMPROBANTES` (PDF/XML) y el Precheckout de Axoft Cobranzas.

```
App Guazu  →  esta API  →  Tango + PDF + Cobranzas
```

## Base URL

| Entorno | URL |
|---|---|
| Oficina (LAN) | `http://<IP-PC-portal>:5173` |
| Público (túnel) | `https://…` (cuando haya dominio fijo) |

Todas las rutas empiezan con `/api/portal/`.

## Autenticación

Header obligatorio (salvo el portal web en el mismo origen):

```http
X-Api-Key: <PORTAL_API_KEY>
```

También vale:

```http
Authorization: Bearer <PORTAL_API_KEY>
```

Sin key válida → `401`.

La key se configura en el servidor (`.env.local` → `PORTAL_API_KEY`). Pedila al equipo Guazu/oficina; **no** va en el repo público.

CORS: habilitado para `GET` con header `X-Api-Key`.

---

## `GET /api/portal/health`

Chequeo rápido. Sin key: solo estado. Con key: lista códigos de prueba conocidos.

**200**

```json
{
  "ok": true,
  "authRequired": true,
  "hasToken": true,
  "clientes": ["101010", "101012"]
}
```

---

## `GET /api/portal/facturas?codigo={COD_GVA14}`

Lista facturas **pagables** del abonado (link de Cobranzas vigente ≈ 40 días desde emisión; no muestra las ya procesadas).

`codigo`: código de cliente Tango (`17`, `000017`, etc.). Se normaliza a 6 dígitos si es numérico.

**Headers**

```http
X-Api-Key: …
```

**200**

```json
{
  "cliente": "BROLLO EDGAR",
  "codigo": "000017",
  "origen": "pdf",
  "saldoCc": 0,
  "facturas": [
    {
      "id": "B0000400063976",
      "nro": "B00004-00063976",
      "vencimiento": "10/09/2026",
      "saldo": 81402.2,
      "estado": "pendiente",
      "cliente": "BROLLO EDGAR",
      "linkPago": "https://cobranzas.axoft.com/Precheckout/?id=…"
    }
  ],
  "inactivo": false,
  "sinComprobantes": false,
  "aviso": "Vence el 10/09/2026 · $ 81.402,20 (dato de Cobranzas)."
}
```

| Campo | Uso en app |
|---|---|
| `facturas[].nro` | Mostrar número |
| `facturas[].saldo` | Importe a cobrar |
| `facturas[].vencimiento` | Fecha |
| `facturas[].linkPago` | Abrir WebView / browser para pagar |
| `facturas[].estado` | `pendiente` \| `pagada` |
| `inactivo` | Código que ya no es abonado |
| `sinComprobantes` | Cliente OK pero aún sin FAC |
| `aviso` | Texto opcional para UI |

**404** — código inexistente en Tango  
**401** — API key  
**502** — Tango / red

---

## `GET /api/portal/pdf?codigo={COD}&nro={NRO}`

Devuelve el PDF de la factura (`Content-Type: application/pdf`).

- Ver en app: misma URL en WebView / visor.
- Descargar: agregá `&dl=1`.

Ejemplo:

```http
GET /api/portal/pdf?codigo=000017&nro=B00004-00063976
X-Api-Key: …
```

---

## `GET /api/portal/cobro?link={URL_PRECHECKOUT}&fresh=1`

Consulta si ese Precheckout ya fue pagado (`procesado`).

`link` = valor de `facturas[].linkPago` (URL-encoded).  
`fresh=1` evita cache corta.

**200**

```json
{
  "procesado": false,
  "total": 81402.2,
  "vencimiento": "10/09/2026"
}
```

Flujo sugerido al pagar:

1. Abrir `linkPago` (Cobranzas / Mercado Pago Axoft).
2. Poll cada ~4s a `/api/portal/cobro?link=…&fresh=1`.
3. Si `procesado: true` → refrescar `/api/portal/facturas`.

El recibo lo genera **Axoft/Tango**, no esta API.

---

## Ejemplo (Android / OkHttp)

```http
GET /api/portal/facturas?codigo=000017 HTTP/1.1
Host: …
X-Api-Key: TU_KEY
Accept: application/json
```

```kotlin
val req = Request.Builder()
  .url("$base/api/portal/facturas?codigo=$codigo")
  .header("X-Api-Key", apiKey)
  .get()
  .build()
```

## Qué no hace esta API

- No escribe en la base de Tango.
- No registra cobranzas (lo hace Axoft al pagar).
- No reemplaza el login de la app Guazu: la app debe saber el `COD_GVA14` del abonado (vínculo mail ↔ código) y pasarlo en `codigo`.

## Códigos de prueba (oficina)

Pedí códigos vigentes al equipo (ej. `000017`). Dependen de Tango en vivo.
