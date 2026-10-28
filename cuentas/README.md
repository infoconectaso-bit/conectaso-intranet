# Cuentas

App pequeña e **independiente** con las cuentas mensuales de la vivienda, separadas en
**cuenta casa** y **cuenta piso**: ingresos y gastos fijos (hipoteca, teléfono, luz,
nóminas, alquiler…). Solo comparte el servidor: va en su propio contenedor
(`conectaso-cuentas`), puerto **8083**, con sus datos en `data-cuentas/` (fuera del repositorio).

- Abrir: `http://IP_DEL_SERVIDOR/cuentas/` (pasa por Caddy, puerto 80) o `https://prueba.lol/cuentas/`.
  También directamente en `http://IP_DEL_SERVIDOR:8083` si el cortafuegos tiene ese puerto abierto.
- Un único usuario y contraseña compartidos. La primera vez que se abre pide crearlos.
- Cada movimiento se repite solo (cada mes, cada 2/3/6 meses, anual o solo un mes), con mes de
  inicio y de fin opcional.
- Copia diaria de los datos en `data-cuentas/copias/` (últimos 30 días).
