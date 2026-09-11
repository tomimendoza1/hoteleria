# Hotelería

Aplicación de un hotel: Express, frontend HTML/CSS/JS y PostgreSQL en Neon, desplegada en Vercel.

## Entornos

- Producción: proyecto Neon hoteleria, rama main; Vercel Production.
- Pruebas: rama Neon pruebas; Vercel Preview y desarrollo local.
- Vercel y Neon usan la región US East (iad1 / aws-us-east-1).
- Docker no es necesario. docker-compose.yml se conserva como alternativa local opcional.
- No hay credenciales ni datos de huéspedes en este repositorio. El HTML legado se conserva solo localmente.

## Configuración

Copiar .env.example a .env y configurar DATABASE_URL (Neon pooled, TLS), DATABASE_URL_DIRECT (Neon direct, TLS) y JWT_SECRET (32 bytes aleatorios como mínimo). No usar la base de producción en previews.
La aplicación usa una cookie HttpOnly, SameSite=Lax y Secure en Vercel. Todas las escrituras requieren el encabezado Origin del mismo dominio.
APP_ORIGIN permite fijar el origen si se usa un proxy personalizado.

```powershell
npm ci
npm run migrate
npm start
```

Abrir http://localhost:3008. Las migraciones usan conexión directa, control de versiones, checksums y bloqueo; no se ejecutan durante builds ni solicitudes. No editar una migración ya aplicada: agregar otra.

Para crear el administrador, definir ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 16 caracteres) solo en el entorno privado y ejecutar npm run create-admin. No sobreescribe usuarios existentes; quitar esas variables del entorno de ejecución después.

## Despliegue

GitHub main se conecta a Vercel; configurar DATABASE_URL y JWT_SECRET distintos para Production y Preview. DATABASE_URL_DIRECT se utiliza fuera de la función, en el paso explícito de migración. Aplicar primero las migraciones en pruebas, probar el preview y luego aplicar en producción antes del despliegue.
Nunca incluir secretos en argumentos de comandos ni commits.

## Verificación

```powershell
$env:RUN_DB_TESTS='1'
node --env-file=.private/testing.env --test test/integration.test.js
```

Esta prueba requiere la rama de pruebas configurada; crea datos sintéticos persistentes y rechaza ejecutarse contra otro endpoint. Verifica sesión, logout, origen, reservas concurrentes, persistencia, cierre de caja, movimientos y stock. npm test sin variables omite las pruebas de integración explícitamente.
El primer seed contiene 31 habitaciones, capacidad 2 y tarifa 0 como valores provisionales que deben revisarse antes de operar.

## Limitaciones conocidas

MVP, no sistema hotelero final. Pendientes: calendario, edición completa, interfaz de usuarios/roles, reportes avanzados, consumos y proveedores estructurados, recuperación de contraseña y revocación inmediata de sesiones robadas.
Las escrituras se serializan con un bloqueo PostgreSQL para asegurar caja/auditoría; suficiente para un hotel, revisar para mayor volumen.
El importador CSV legado aún tiene un parser simple: no usar con separadores o saltos de línea dentro de celdas; no se ha migrado ningún dato real.
La exportación JSON incluye cierres y auditoría, pero no usuarios/sesiones: no reemplaza un respaldo PostgreSQL. Antes de cambios operativos hacer un respaldo completo con pg_dump y probar su restauración en una rama aislada; no se ha validado recuperación ante desastres.
