# TCG LEVI Online — arquitectura y puesta en marcha

## Decisiones del proyecto
- Acceso privado por invitación. Desactivar el registro público en Supabase Auth.
- Colecciones nuevas: no importar ni migrar `localStorage`.
- Se permite intercambiar cualquier carta, incluso la última copia.
- La reserva impide ofrecer una misma copia en dos intercambios pendientes.
- Aperturas, contadores, garantías SR/UR y transferencias se validan en PostgreSQL.

## Arquitectura
- Frontend: el HTML/CSS/JS actual, compilado con Vite y publicado en Vercel.
- Identidad y sesiones: Supabase Auth (invitaciones por email).
- Datos: Supabase PostgreSQL con RLS.
- Operaciones críticas: funciones RPC transaccionales en `supabase/schema.sql`.
- Imágenes: mantener `cartas/` y `assets/` en el hosting inicialmente; después se puede mover a Storage/CDN.
- Código fuente: GitHub conectado a Vercel.

## Pasos de configuración
1. Crear un proyecto en https://supabase.com/ y guardar la URL y la publishable/anon key.
2. En Supabase > SQL Editor, ejecutar `supabase/schema.sql`.
3. En Authentication > Providers > Email, habilitar email y configurar SMTP para invitaciones reales.
4. En Authentication > Settings / User Signups, desactivar los registros públicos. Los usuarios se crean desde Authentication > Users > Invite user (o desde un backend administrativo protegido).
5. En Authentication > URL Configuration, configurar el dominio de Vercel y la URL local de desarrollo como redirect URLs.
6. Instalar dependencias con `npm install`. En Vercel, configurar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` como variables de entorno para Production y Preview. No se requiere `supabase-config.js` en el despliegue.
7. Importar el catálogo ejecutando `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:cards` (PowerShell: `$env:SUPABASE_URL=...; $env:SUPABASE_SERVICE_ROLE_KEY=...; npm run seed:cards`). La clave `service_role` se usa solo localmente y nunca en el navegador.
8. Conectar el repositorio a Vercel. Usar `npm run build` como comando de build y `dist` como directorio de salida. Vite copia `cartas.js` y `assets/`; las imágenes de cartas siguen referenciadas desde Supabase Storage y no se agregan al repositorio.

## Migración de intercambios
En un proyecto que ya ejecutó `supabase/schema.sql`, abrir Supabase > SQL Editor y ejecutar una sola vez `supabase/migrations/20261111_trade_safety.sql`. El script está envuelto en una transacción y reemplaza las tres RPC existentes sin borrar datos ni tablas. Endurece permisos de escritura, valida las listas y cantidades del lado servidor, agrega IDs repetidos antes de reservar/transferir, revalida el inventario del destinatario al aceptar, serializa operaciones de inventario concurrentes y notifica también las cancelaciones.

En un proyecto nuevo, ejecutar primero `supabase/schema.sql` y después la migración. El catálogo debe estar importado antes de abrir sobres o intercambiar cartas. Las colecciones son nuevas: no se importan automáticamente desde `localStorage`.

## RPC disponibles después de aplicar el SQL
- `open_pack()` abre un sobre de 5 cartas, suma al total y aplica SR en 11, 21, 31... y UR en 101, 201... (UR tiene prioridad). Devuelve `card_ids`.
- `create_trade(recipient_uuid, offer_json, request_json, message)` crea la propuesta y reserva las cartas que ofrece el creador; las cartas solicitadas al otro jugador se verifican y descuentan al aceptar.
- `respond_trade(trade_uuid, true|false)` acepta o rechaza; la aceptación transfiere todo de forma atómica.
- `cancel_trade(trade_uuid)` permite al creador cancelar y libera las reservas.

Formato de cada lista de cartas: `[ {"card_id": 12, "quantity": 1} ]`.

## Estado de esta entrega
La interfaz existente incluye ahora Crear, Recibidos, Enviados e Historial, autenticación por invitación, búsqueda de jugadores, selección/cantidades, vista previa, respuesta/cancelación y notificaciones. Al iniciar sesión, sobres y colección usan las RPC y tablas remotas; sin sesión se conserva el comportamiento local. Antes de abrirlo a jugadores, todavía se deben aplicar la migración, configurar Vercel, importar el catálogo y completar las pruebas con dos cuentas reales.

## Seguridad y pruebas obligatorias antes de abrirlo
- Confirmar que un usuario anónimo no puede leer perfiles, cartas de usuarios, trades ni notificaciones.
- Confirmar que un usuario no puede escribir `user_cards` directamente.
- Confirmar que `authenticated` no puede escribir directamente en `user_cards`, `trades` ni `trade_items`, y que solo puede actualizar `display_name`/`avatar_url` en su perfil y `read_at` en sus notificaciones.
- Probar en dos sesiones la oferta simultánea de la última copia: una sola propuesta puede reservarla; la otra debe fallar sin crear una reserva parcial.
- Probar cantidades duplicadas del mismo `card_id` (la suma debe validarse), IDs/cantidades manipulados desde DevTools y petición de cartas que el destinatario ya no tiene.
- Probar que solo el destinatario acepta/rechaza, solo el remitente cancela, y que repetir aceptar/rechazar/cancelar no transfiere dos veces.
- Probar aceptar dos intercambios concurrentes que afecten una misma carta: no debe haber saldo negativo, pérdida ni duplicación.
- Confirmar que rechazar/cancelar libera reservas sin cambiar cantidades y que aceptar/cancelar genera notificación a la otra parte.
- Probar garantías en sobres 11, 21, 101 y 201; UR debe ganar en el 101/201.
- No publicar nunca la `service_role` key en Vercel frontend ni en GitHub.

## Prueba manual con dos cuentas
1. Invitar dos cuentas desde Supabase Auth y abrir la app en dos sesiones distintas.
2. Abrir sobres en ambas cuentas y confirmar que las cartas aparecen en Colección online.
3. En A, crear una propuesta a B con varias cartas/cantidades; verificar que A las ve como reservadas y B recibe una notificación.
4. En B, revisar Recibidos, imágenes, expansiones, rarezas y cantidades. Aceptar y comprobar que las cantidades se transfieren en ambas colecciones y el estado aparece en Historial.
5. Repetir y rechazar; luego crear otra propuesta y cancelarla desde A. En ambos casos las cantidades deben permanecer iguales y las reservas liberarse.
6. Repetir con dos propuestas simultáneas por las mismas últimas copias y con una modificación de cantidad/ID desde la consola; PostgreSQL debe rechazar las operaciones inválidas sin efectos parciales.

## API cliente preparada
`online-client.js` expone `window.TCGOnline` al completar la configuración. Incluye sesión, perfil, colección, apertura de sobres, búsqueda de jugadores, creación/respuesta/cancelación de trades y notificaciones. Se carga como módulo después de `supabase-config.js`. La interfaz visible todavía debe conectarse a estos métodos: no se debe considerar listo para jugadores hasta terminar esa integración y las pruebas de seguridad.
