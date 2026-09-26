# Dispatch para iPhone — instalación y prueba

## Estado de esta entrega (26 septiembre 2026)

- Proyecto generado desde `ios/project.yml` con XcodeGen.
- Compilación Debug arm64 para iPhone correcta con Xcode 27.0, destino genérico iOS, **sin firma**. No es todavía un IPA instalable.
- Revisado el Info.plist dentro del producto compilado: ambas descripciones de permisos, `UIBackgroundModes = location`, iPhone, mínimo iOS 16.
- Pruebas HTTP de los handlers y SQL de producción con PostgreSQL embebido PGlite: permisos Dispatch, coordenadas y tiempo válidos, GPS obligatorio para avanzar/cobrar, posición antigua, check-out, envío tardío rechazado y aislamiento de turnos nuevos.
- Pruebas JavaScript: no activar geolocalización web en el contenedor nativo; puente check-in/refresh/check-out; ignorar callback nativo después de salir; enviar hora real del GPS desde navegador.
- No se probó todavía con un iPhone, firma Apple, servidor desplegado, red móvil ni concurrencia multiconexión de PostgreSQL real. PGlite ejecuta las pruebas en una conexión.
- No se publicó en App Store ni se actualizó producción.

## Preparar el servidor

La app carga la interfaz web existente desde una URL HTTPS y usa Core Location nativo para el GPS. Los cambios de `app.js`, `server.js` y `service-worker.js` deben desplegarse juntos en ese servidor **antes de probar**. No basta con instalar el contenedor iOS.

1. En el servidor, instalar dependencias con `pnpm install --frozen-lockfile` (o `npm install`).
2. Conservar/configurar `DATABASE_URL`, `JWT_SECRET`, `DISPATCH_ACCESS_CODE`, `DRIVER_NAMES` y `DRIVER_ACCESS_CODES` (objeto JSON de PIN único de cuatro cifras por conductor). Usar las credenciales de ese entorno, nunca incorporarlas en la app.
3. Ejecutar `node server.js`. El arranque añade `recorded_at` y `session_id` a `driver_locations` y crea `driver_shifts`; el usuario de PostgreSQL debe poder hacer esos cambios. Probar primero con una copia/entorno de pruebas.
4. Verificar `/api/health` desde la dirección HTTPS pública. Debe responder `{"ok":true}` y el certificado debe ser válido.
5. Cerrar las sesiones anteriores y hacer un check-in nuevo: los tokens antiguos no contienen el identificador de turno. Recargar también Dispatch. El nuevo service worker deja de fijar una versión antigua de app.js.

No usar `localhost` en el iPhone: se referiría al teléfono. La app acepta únicamente el origen HTTPS, sin rutas, usuario/contraseña, parámetros o fragmentos.

## Instalar directamente con Xcode

1. Abrir `ios/MMPatriotsDispatch.xcodeproj` en Xcode. Ya está generado. Para regenerarlo: `xcodegen generate --spec ios/project.yml` desde la raíz.
2. Xcode → Settings → Accounts: añadir tu Apple Account. Seleccionar el target **MMPatriotsDispatch** → Signing & Capabilities → activar **Automatically manage signing**, elegir tu **Team** y un Bundle Identifier único. Si regeneras el proyecto, guarda ese identificador también en `project.yml`.
3. Conectar el iPhone por cable, desbloquearlo y aceptar **Confiar**. Activar **Developer Mode** en Ajustes → Privacidad y seguridad si iOS lo solicita; reiniciar y confirmar.
4. Seleccionar el iPhone como destino en Xcode, no “Any iOS Device”. Pulsar **Run (⌘R)**. Xcode deberá crear la firma y el perfil; cualquier problema de cuenta o aprovisionamiento se resolverá ahí.
5. Si aparece “desarrollador no fiable”, autorizar la cuenta en Ajustes → General → VPN y gestión de dispositivos.
6. Abrir Dispatch e introducir la dirección HTTPS del servidor actualizado. Iniciar como conductor.
7. Permitir ubicación **Al usar la app** en el primer aviso y después **Siempre**. Si no aparece el segundo aviso, usar el botón **Settings** de la app y seleccionar **Siempre**, con **Ubicación precisa** activada. Mantener Localización global activada.

Sin esos permisos el turno aparece como pendiente/offline y las acciones quedan bloqueadas. La app no puede conceder permisos por el usuario. “Change Server” está deshabilitado durante el turno: hacer Check Out primero.

## Prueba de aceptación en el teléfono

Abrir Dispatch en otro equipo con una sesión de dispatcher y usar un conductor/trip de prueba, sin datos reales de pacientes. Hacer la parte en movimiento como pasajero.

| Paso | Resultado esperado |
| --- | --- |
| Check In y denegar ubicación | Conductor visible como esperando ubicación; aceptar viaje/cobrar bloqueados. |
| Activar Siempre + Precisa | Posición y enlace al mapa en Dispatch, hora GPS y hora de recepción. |
| Dejar el teléfono quieto 3–5 minutos | Se siguen recibiendo fixes cuando iOS los entrega; si pasan 60 s sin uno reciente, mostrar última posición antigua, nunca “Live” indefinidamente. |
| Salir a Inicio y moverse 5–10 minutos | Coordenadas y horas cambian en Dispatch. |
| Bloquear pantalla y moverse 10–15 minutos | Continúan las actualizaciones con el teléfono bloqueado. Repetir desconectado de Xcode y de Wi-Fi, con datos móviles. |
| Cortar la red más de 60 segundos | Dispatch muestra posición antigua. No se inventan posiciones ni se renueva la hora GPS con datos viejos. |
| Recuperar la red | El próximo fix fresco se entrega y vuelve a estado reciente. |
| Revocar Siempre o Precisa durante el turno | Estado local de permiso requerido; sin envíos posteriores desde el cliente; Dispatch pasa a antiguo. |
| Check Out con red | GPS se detiene localmente y desaparece el turno de Dispatch después de confirmarse y refrescarse (poll cada 5 s). Moverse/bloquear después: no debe reaparecer. |
| Check Out sin red | GPS se detiene de inmediato; la confirmación remota queda pendiente en Keychain. Abrir la app con red: se reintenta y desaparece de Dispatch. Mientras no llega el check-out, Dispatch puede conservar la última posición, marcada antigua. |
| Nuevo check-in y reintento de un check-out viejo | El turno nuevo conserva su ubicación. Solo puede estar activo el último turno de cada conductor. |
| Cerrar la app a la fuerza y reabrir | No prometer rastreo estando forzada a cerrar. Al reabrir se recupera la sesión web válida; si expiró, volver a iniciar sesión. |

Anotar modelo/iOS, permisos, hora de cada paso, hora GPS/recepción que muestra Dispatch y resultado. Comprobar también consumo de batería durante un turno real antes de distribuir.

## Funcionamiento y límites

Core Location mantiene las actualizaciones nativas durante un turno con `allowsBackgroundLocationUpdates`, sin pausa automática y con indicador de ubicación. Se solicitan fixes incluso estando quieto y se limitan los envíos a uno por cada 10 segundos como máximo; **no es una garantía de frecuencia**. No se usa un temporizador JavaScript para el GPS nativo. La precisión alta continua consume batería.

El check-out cancela el envío en curso, detiene Core Location y revoca el turno en el servidor. El servidor serializa cargas/check-out con un bloqueo de fila en PostgreSQL: una carga tardía no puede revivir un turno revocado. Una nueva sesión sustituye a la anterior. Los turnos duran 12 horas. Dispatch considera reciente solo una muestra GPS de los últimos 60 segundos.

Sin red, teléfono apagado, cierre forzado o suspensión por el sistema no se puede garantizar entrega continua. El reintento de un check-out offline requiere que la app pueda ejecutarse de nuevo. El navegador por sí solo no ofrece el rastreo nativo en segundo plano.

Referencia Apple: https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates

## Verificación reproducible

```sh
pnpm install --frozen-lockfile
pnpm test
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/MMPatriotsDispatch.xcodeproj \
  -scheme MMPatriotsDispatch -configuration Debug \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/dispatch-build CODE_SIGNING_ALLOWED=NO build
plutil -p /tmp/dispatch-build/Build/Products/Debug-iphoneos/MMPatriotsDispatch.app/Info.plist
```

La única advertencia final de compilación fue la omisión de metadatos AppIntents porque la app no usa ese framework. La validación de firma y la instalación se realizan con el Team y el iPhone del usuario. No usar Archive/Distribute App para esta prueba.


## Avisos de asignación y cancelación

El servidor guarda una notificación por conductor y cambio de asignación en la misma transacción del viaje. Incluye conductor auxiliar, reasignación, Cancel Trip y Delete Trip. Los regresos pendientes avisan al pulsar Dispatch Return. Cancel Trip conserva el tramo cancelado en Dispatch y lo retira del conductor; no cancela el otro tramo del R/T.

La bandeja Notifications consulta cada 5 segundos con la web abierta y conserva los avisos hasta Mark as read, incluso si se borra el viaje. La app iOS solicita permiso para avisos y sonido al hacer check-in. Su consulta nativa se limita a una cada 10 segundos mientras iOS permite ejecutar el turno, incluidos los callbacks de ubicación en segundo plano. Guarda los identificadores ya anunciados por servidor/conductor para evitar repetir sonidos. Check Out detiene las consultas y limpia los avisos del sistema.

Estos son avisos locales basados en consultas, no APNs: sin red o con la app suspendida/cerrada no se garantiza aviso inmediato. Los eventos se recuperan al volver. La pantalla bloqueada no muestra nombres, direcciones ni datos de pago. Para avisos remotos independientes de la ejecución de la app se necesita configurar APNs y la firma/cuenta Apple correspondiente.

Prueba física pendiente: instalar esta nueva compilación, aceptar notificaciones, asignar/reasignar/cancelar/borrar un viaje de prueba, verificar un solo aviso por evento, probar regreso pendiente/liberado, bloqueo de pantalla, pérdida de red, denegación de permiso y check-out. La bandeja debe seguir funcionando si se deniega el sonido o los avisos del sistema.

API de Apple utilizada: https://developer.apple.com/documentation/usernotifications/unusernotificationcenter

## Sonidos por evento para Dispatch y Driver

- Dispatch: `accepted` se genera cuando el conductor avanza de Assigned a Accepted; tono de dos notas (880/1100 Hz).
- Dispatch: `dropped_off` se genera al confirmar Patient dropped off / Complete trip (estado Completed); melodía de cuatro notas (523/659/784/1047 Hz). Llegar al destino por sí solo no confirma que dejó al paciente.
- Driver: `assigned`, tres notas ascendentes (660/880/1100 Hz); `cancelled`, tres notas descendentes (440/330/220 Hz).

En navegador, pulsar Enable notification sounds después de abrir la app. El botón reproduce una prueba; si el navegador lo permite, también solicita permiso para notificaciones del sistema. La bandeja funciona sin permiso. Cada evento suena una vez por navegador y destinatario; los identificadores se guardan localmente. El sonido necesita que el navegador siga ejecutándose y no esté silenciado. No hay entrega web push con el navegador cerrado.

En el contenedor iPhone actualizado, el conductor usa los WAV incluidos en el bundle y se evita el sonido duplicado del JavaScript. Los WAV PCM duran 0.66 s cada uno. Dispatch usa el audio de la vista web mientras permanece abierta. El modo silencio, Focus y los ajustes de sonido del dispositivo pueden silenciar los avisos.

Validación local: 8 pruebas automatizadas correctas; compilación Debug arm64 para iPhone sin firma correcta, con assigned.wav y cancelled.wav incluidos en Resources. Falta escuchar los avisos en los dispositivos reales y verificar bloqueo/segundo plano. No se desplegaron estos cambios.

Referencia para sonidos nativos: https://developer.apple.com/documentation/usernotifications/unnotificationsound
