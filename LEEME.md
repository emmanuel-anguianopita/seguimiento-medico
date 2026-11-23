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


## Novedades de esta versión

- **Saludo:** la pantalla principal dice «¡Bienvenido Nombre!». El nombre sale del paciente; puede cambiarse en ⋯ → Perfil del paciente.
- **Histórico:** pestaña nueva con todos los indicadores en filas y las fechas de cada informe en columnas, coloreados por estado. Tocar un indicador abre su gráfica. Incluye búsqueda, filtro y exportación a CSV.
- **Peso y composición corporal:** además del peso se capturan % de grasa, % de agua y masa ósea (kg). El IMC se calcula solo con la altura del perfil, y la tarjeta de composición evalúa cada valor según sexo y edad. Es una lectura informativa, no un diagnóstico.
- **Perfil del paciente:** altura, sexo y fecha de nacimiento (se toman del PDF cuando vienen). Si el paciente tiene contraseña, el perfil también se guarda cifrado.
- **Formatos de laboratorio:** la lista está en `js/parser.js` (`LAB_PROFILES`). Si un PDF no se reconoce, el aviso ofrece «Copiar texto del PDF» para pasarlo y agregar el formato nuevo.

Al publicar, reemplaza todos los archivos del repositorio por los de esta versión; la caché se actualiza sola (versión v3).


## Formato agregado: Laboratorio Universidad de Guadalajara (inmunología)

Lee proteína C reactiva, tiroides, sedimentación, anticuerpos (anti-CCP, factor reumatoide, HLA-B27, ANCA, antinucleares, perfil de 18 anticuerpos), biometría hemática y química hepática. Aparece una categoría nueva, «Inmunología». El nombre del paciente se reconoce aunque el laboratorio ponga primero el nombre y después los apellidos.

## Clasificación por sistema u órgano

En Análisis e Histórico hay un selector «Agrupar por: Estudio / Sistema u órgano». La clasificación está en `js/systems.js` y se puede ajustar. El CSV exportado incluye una columna «Sistema u órgano». La elección se recuerda en el dispositivo.

## Cuestionario inicial y calendario menstrual

- **Primera pantalla:** al abrir la aplicación sin datos aparece un cuestionario con nombre, fecha de nacimiento (calcula la edad), género, peso, altura, raza u origen (opcional) y, si se desea, el calendario menstrual. También se puede abrir después en ⋯ → Perfil del paciente.
- **Calendario menstrual (opcional):** pregunta la fecha de la última regla, la duración del ciclo y de la regla, y si los ciclos son regulares. La pestaña «Ciclo» muestra la fase, el día del ciclo, la próxima regla, la ovulación y la ventana fértil estimadas, un calendario por mes y permite registrar cada inicio de regla (el promedio del ciclo se ajusta con el historial). Es una estimación y no sirve como método anticonceptivo.
- La raza solo se guarda como dato de contexto y no cambia ningún cálculo. El perfil completo, incluido el ciclo, se cifra si el paciente tiene contraseña.

# Versión con acceso de pacientes y PDF guardados

## Cómo funciona
- **Profesional** (tú): abres la dirección de la aplicación terminada en `#admin` (por ejemplo `https://TU-USUARIO.github.io/TU-REPOSITORIO/#admin`). Ahí importas los PDF, que se leen y se **guardan por paciente** en tu dispositivo. Cada vez que importas un estudio, la aplicación abre la pestaña **Avances** y muestra qué mejoró, qué empeoró y qué es nuevo.
- **Paciente**: abre la dirección normal (sin `#admin`), escribe su nombre completo y su contraseña, y ve Análisis, Avances, Histórico, Peso, Ciclo e Informes (con sus PDF). Es de solo lectura y la sesión se cierra sola a los 5 minutos.
- Los resultados y los PDF llegan al paciente a través de GitHub, siempre **cifrados** con la contraseña de ese paciente. Sin el nombre y la contraseña no se puede leer nada.

## Publicar los resultados de un paciente
1. En la aplicación (modo profesional): menú ⋯ → **Publicar resultados para el paciente**.
2. Escribe una contraseña de al menos 12 caracteres (la misma cada vez para ese paciente) y entrégasela por otro medio.
3. Se genera un archivo `resultados-XXXX.zip`. Ábrelo: trae un archivo `.json` y una carpeta con el mismo código.
4. Copia ambos dentro de la carpeta `data` del repositorio (créala la primera vez) y reemplaza si ya existen.
5. En GitHub Desktop: escribe un resumen, **Commit to main** y **Push origin**.
6. Repite con cada estudio nuevo.

## Actualizar los archivos de la aplicación en GitHub
1. Descomprime `seguimiento-medico-pwa.zip`; queda una carpeta `seguimiento-medico`.
2. En GitHub Desktop: **Repository → Show in Finder** (Mac) o **Show in Explorer** (Windows) para abrir la carpeta del repositorio.
3. Copia **todo lo que hay dentro** de `seguimiento-medico` a la carpeta del repositorio y elige **Reemplazar** cuando lo pregunte. No toques la carpeta `data`: el zip no la incluye.
4. Vuelve a GitHub Desktop: verás los archivos cambiados. Resumen, **Commit to main**, **Push origin**.
5. Espera uno o dos minutos y abre la aplicación dos veces para que se actualice sola.

## Recomendaciones de seguridad
- El repositorio es público: los archivos publicados están cifrados, pero cualquiera puede descargarlos. Usa contraseñas largas y distintas por paciente.
- Si un paciente olvida su contraseña, se publica de nuevo con otra.
- Los datos de salud están sujetos a la ley de protección de datos personales; informa a tus pacientes con un aviso de privacidad y su consentimiento.
- Haz una copia de respaldo con regularidad (menú ⋯ → Exportar copia de respaldo; ahora incluye los PDF).

## Privacidad y buscadores
- La página incluye etiquetas para que Google y otros buscadores **no la indexen** (`noindex`, `nofollow`, `noarchive`). Funcionan cuando el buscador visita la página, por eso no se usa un `robots.txt` que lo impida. Si la dirección ya apareció en Google, pide su retiro en Google Search Console (herramienta «Eliminaciones»).
- No hay ningún enlace público a los archivos de pacientes y sus nombres son un código derivado del nombre del paciente.
- Contraseñas: al menos 12 caracteres; lo ideal son 4 palabras al azar sin relación entre sí.


# Pantalla de acceso con lista de pacientes

- **Primera pantalla del paciente:** solo muestra la leyenda «Anatomía según Emmanuel Anguiano», una lista desplegable con los nombres y el campo de contraseña. Sin elegir el nombre y escribir la contraseña correcta no se ve ningún resultado.
- **Lista de pacientes:** se publica en `data/pacientes.json`. Cada vez que usas ⋯ → **Publicar resultados para el paciente**, el `.zip` trae ese archivo actualizado con todos los pacientes que has publicado desde ese dispositivo, más el archivo cifrado del paciente y sus PDF. Copia todo dentro de la carpeta `data` del repositorio y reemplaza.
- **Privacidad de la lista:** los nombres de la lista son visibles para quien abra la dirección. Al publicar puedes escribir el «Nombre que aparecerá en la lista de acceso» (por ejemplo, un nombre corto o un apodo). Los resultados y los PDF siguen cifrados con la contraseña de cada paciente.
- **Frase de ánimo:** la tarjeta de composición corporal (donde aparece el IMC) muestra «Lo estás logrando: tu constancia se nota y tienes un cuerpo extraordinario. Sigue así.»
- Para entrar como profesional, abre la dirección terminada en `#admin`; ya no hay enlace visible en la pantalla de acceso.


# Estandarización de nombres de indicadores (versión 12)

- Los nombres equivalentes de distintos laboratorios (por ejemplo «TGO», «AST», «SGOT», «Aspartato aminotransferasa»; «Glucosa en ayunas», «Glucosa sérica»; «Westergren», «VSG») se unifican en un solo indicador, así que el histórico y los avances los muestran en una sola fila. La tabla está en `js/parser.js` (funciones `al(...)` para sangre y `alo(...)` para orina); para agregar una equivalencia basta una línea.
- También se ignoran acentos, mayúsculas, signos, plurales y palabras de relleno («en suero», «sérico»). Las unidades equivalentes se unifican (por ejemplo `meq/L` y `mmol/L` para sodio, potasio y cloruro).
- Los estudios ya importados se estandarizan solos al abrirlos; no hace falta volver a importarlos.
- Formato Chopo con «Química integral», hierro, inmunoglobulinas y orina cualitativa (Negativo, Ausentes): ahora se lee completo, y la categoría se deduce del nombre cuando el PDF no la rotula.
- Si se importa un segundo PDF del mismo estudio (mismo paciente, laboratorio, fecha y folio), se combina con el existente en un solo informe y se conserva el PDF más completo.

# Formato agregado: laboratorio con sistema PasNet (versión 13)

Lee el informe «Resultados» con columnas Estudio, Resultado, Unidades y Valores de referencia (hematología con diferencial en porcentaje y absolutos, química, perfil de lípidos y orina con resultados cualitativos). Toma del encabezado el paciente, la fecha de registro, el sexo, la fecha de nacimiento y el folio. Los nombres y las unidades se estandarizan igual que en los demás laboratorios (por ejemplo `K/uL` pasa a `10³/µL`, «Granulocitos GRA» a «Neutrófilos» y «UREA/BUN» a «Urea»). El PDF no trae el nombre del laboratorio; aparece como «Laboratorio clínico (sistema PasNet)» y se cambia en `LAB_PROFILES` de `js/parser.js`.

# Varios pacientes en la lista de acceso (versión 14)

Al publicar, `pacientes.json` suma a los pacientes que ya están en la lista publicada del sitio (`data/pacientes.json`) y a los publicados desde este dispositivo, por lo que publicar a un paciente nuevo ya no saca a los anteriores. Para que funcione, abre la aplicación de administrador desde la dirección real del sitio (`https://usuario.github.io/repositorio/#admin`). Un paciente publicado con versiones anteriores a la 10 no está en la lista: vuelve a publicarlo una vez. Para quitar a un paciente, borra sus archivos de `data`, quita su línea de `pacientes.json` y haz Commit y Push antes de publicar a otro.
