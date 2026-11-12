# TCG LEVI Online — arquitectura y puesta en marcha

## Decisiones del proyecto
- Acceso privado por invitación. Desactivar el registro público en Supabase Auth.
- Colecciones nuevas: no importar ni migrar `localStorage`.
- Se permite intercambiar cualquier carta, incluso la última copia.
- La reserva impide ofrecer una misma copia en dos intercambios pendientes.
- Aperturas, contadores, garantías SR/UR y transferencias se validan en PostgreSQL.

## Arquitectura
- Frontend: el HTML/CSS/JS actual, publicado en Vercel.
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
6. Copiar `supabase-config.example.js` como `supabase-config.js` y completar URL y clave pública.
7. Instalar dependencias con `npm install`. Importar el catálogo ejecutando `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:cards` (PowerShell: `$env:SUPABASE_URL=...; $env:SUPABASE_SERVICE_ROLE_KEY=...; npm run seed:cards`). La clave `service_role` se usa solo localmente y nunca en el navegador.
8. Subir el proyecto a un repositorio privado de GitHub y conectarlo a Vercel. Incluir `cartas/` (o migrar imágenes a Storage).

## RPC disponibles después de aplicar el SQL
- `open_pack()` abre un sobre de 5 cartas, suma al total y aplica SR en 11, 21, 31... y UR en 101, 201... (UR tiene prioridad). Devuelve `card_ids`.
- `create_trade(recipient_uuid, offer_json, request_json, message)` crea la propuesta y reserva las cartas que ofrece el creador; las cartas solicitadas al otro jugador se verifican y descuentan al aceptar.
- `respond_trade(trade_uuid, true|false)` acepta o rechaza; la aceptación transfiere todo de forma atómica.
- `cancel_trade(trade_uuid)` permite al creador cancelar y libera las reservas.

Formato de cada lista de cartas: `[ {"card_id": 12, "quantity": 1} ]`.

## Estado de esta entrega
Esta entrega prepara el esquema, las reglas de seguridad, las operaciones críticas y la guía de despliegue. Todavía no está conectado a un proyecto Supabase real: faltan URL/clave, carga del catálogo, invitaciones, dominio y terminar de conectar la interfaz actual a Auth/RPC. El juego local no se reemplaza hasta que esas credenciales existan y podamos probar la migración de punta a punta.

## Seguridad y pruebas obligatorias antes de abrirlo
- Confirmar que un usuario anónimo no puede leer perfiles, cartas de usuarios, trades ni notificaciones.
- Confirmar que un usuario no puede escribir `user_cards` directamente.
- Probar intercambio simultáneo de la última copia: solo una operación puede reservarla.
- Probar aceptar/rechazar/cancelar, y que no queden reservas colgadas.
- Probar garantías en sobres 11, 21, 101 y 201; UR debe ganar en el 101/201.
- No publicar nunca la `service_role` key en Vercel frontend ni en GitHub.

## API cliente preparada
`online-client.js` expone `window.TCGOnline` al completar la configuración. Incluye sesión, perfil, colección, apertura de sobres, búsqueda de jugadores, creación/respuesta/cancelación de trades y notificaciones. Se carga como módulo después de `supabase-config.js`. La interfaz visible todavía debe conectarse a estos métodos: no se debe considerar listo para jugadores hasta terminar esa integración y las pruebas de seguridad.
