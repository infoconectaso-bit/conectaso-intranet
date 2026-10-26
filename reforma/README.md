# Reforma

App pequeña e **independiente** para apuntar los gastos de la reforma de casa, en dos
apartados: **pagado por la empresa** y **pagado por nosotros**. Solo comparte el
servidor: va en su propio contenedor (`conectaso-reforma`), en el puerto **8082**, con
sus propios usuarios y sus datos en `data-reforma/` (fuera del repositorio).

- Abrir: `http://IP_DEL_SERVIDOR:8082`.
- La primera vez que se abre pide crear la primera cuenta. Las demás personas se
  añaden desde **Ajustes → Añadir persona**.
- Subir la foto de un ticket: el servidor la lee con **Tesseract** (gratis, sin
  servicios externos) y propone tienda, fecha, total, descuentos, IVA, categoría y
  concepto. Siempre se revisa antes de guardar.
- Fotos en `data-reforma/fotos/`; copia diaria de los datos en `data-reforma/copias/`
  (últimos 30 días). Exportación a Excel (CSV) desde Ajustes.
