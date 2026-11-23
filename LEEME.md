# Seguimiento médico (aplicación web instalable)

Funciona en iPhone sin App Store, sin cuenta de desarrollador y sin fecha de caducidad.
Lee PDF de análisis de sangre (Centro Analítico Mariano Otero y Chopo), guarda la historia y gráfica cada parámetro. El peso se captura a mano.
Los PDF se leen dentro del teléfono y los datos se guardan solo ahí; no hay servidor ni base de datos en línea.

## Publicarla gratis (una sola vez)
La carpeta `seguimiento-medico` no contiene ningún dato personal, así que puede estar en un repositorio público.

1. Crea una cuenta en github.com.
2. Crea un repositorio nuevo, público, por ejemplo `seguimiento-medico`.
3. En el repositorio: Add file > Upload files. Arrastra el CONTENIDO de la carpeta `seguimiento-medico` (index.html, sw.js, manifest.webmanifest y las carpetas css, js, vendor e icons). Confirma con Commit changes.
4. Settings > Pages > Source: "Deploy from a branch", rama `main`, carpeta `/ (root)`. Guarda.
5. En uno o dos minutos aparece la dirección: https://TU-USUARIO.github.io/seguimiento-medico/

## Instalarla en el iPhone
1. Abre esa dirección en Safari.
2. Botón Compartir > Agregar a pantalla de inicio.
3. Abre la aplicación desde el icono de la pantalla de inicio e importa ahí los PDF.

Importante: en iOS, lo que guardes dentro de Safari y lo que guardes dentro del icono de la pantalla de inicio son almacenes separados. Usa siempre el icono.

## Contraseña por paciente
Menú (los tres puntos) > "Proteger con contraseña". Cada paciente puede tener la suya.
- Los informes y los pesos de ese paciente se guardan cifrados (AES de 256 bits, clave derivada de la contraseña con PBKDF2). La contraseña no se guarda en ningún lado.
- El nombre del paciente sigue visible en el selector; lo que se cifra es su contenido.
- La contraseña no se puede recuperar. Si se olvida, los datos de ese paciente no se pueden leer. Por eso conviene tener una copia de respaldo y anotar la contraseña en un lugar seguro.
- Se bloquea sola tras 5 minutos sin usar la aplicación o después de 1 minuto en segundo plano. También puedes usar Menú > Bloquear ahora.
- La copia de respaldo conserva el cifrado.
- Para cambiarla o quitarla hay que escribir la contraseña actual.

## Respaldo
Menú (los tres puntos) > Exportar copia de respaldo. Guarda el archivo en Archivos o iCloud. Para recuperarlo: Menú > Importar copia de respaldo. Hazlo con regularidad y antes de cambiar de teléfono o borrar la aplicación.

## Actualizaciones
Si cambias algún archivo, aumenta el número de versión en `sw.js` (la línea `CACHE = "seguimiento-medico-v1"`) para que los teléfonos descarguen la versión nueva.

## Si un PDF no se lee bien
En Informes, abre el informe y copia el "Texto extraído del PDF". Con ese texto se ajusta el lector (`js/parser.js`).
Los PDF escaneados (imágenes) todavía no se pueden leer: necesitan reconocimiento óptico de texto.
