# Préstamo Conecta

App pequeña e **independiente** de la intranet para seguir un préstamo: lo que falta
por devolver, el cuadro de pagos y los adelantos. Solo comparte el servidor:
va en su propio contenedor (`conectaso-prestamo`), en el puerto **8080**, con su
propia contraseña y sus datos en `data-prestamo/` (fuera del repositorio).

- Abrir: `http://IP_DEL_SERVIDOR:8080`
- La primera vez pide crear la contraseña.
- Los datos del préstamo NO están en el código (el repositorio es público):
  se introducen desde la propia app y se guardan solo en el servidor.
- Copia diaria automática en `data-prestamo/copias/` (últimos 30 días).
