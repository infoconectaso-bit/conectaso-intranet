# Conecta Seguros

App pequeña e **independiente** para tener a mano las pólizas de seguro, separadas
en pestañas (Adri, Alba y Conecta Sonido): lo más útil que cubre cada una, lo que
se paga, cuándo vence y sus puntos débiles. Solo comparte el servidor: va en su
propio contenedor (`conectaso-seguros`), en el puerto **8081**, con su propia
contraseña y sus datos en `data-seguros/` (fuera del repositorio).

- Abrir: `http://IP_DEL_SERVIDOR:8081`
- Los datos y PDF de las pólizas van **cifrados** en `semilla/` (el repositorio es
  público). Se abren con la contraseña inicial; la primera vez que se entra con ella
  el servidor guarda la clave en `data-seguros/` y descifra todo. Luego se puede
  cambiar la contraseña desde la app sin perder nada.
- Cuando se añaden pólizas nuevas a la semilla, el servidor las incorpora solo; lo
  que se haya cambiado a mano en la app (precio, fecha, notas, pestaña) se respeta.
- Copia diaria automática en `data-seguros/copias/` (últimos 30 días).
