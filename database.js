require("dotenv").config();
const dns = require("dns");
try {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
} catch (e) {
  console.warn("No se pudo configurar DNS público:", e.message);
}
const { Pool } = require("pg");
const mongoose = require("mongoose");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

let pgPool = null;
let isPgMock = false;
let pgMockDb = null; // SQLite fallback database

let isMongoMock = false;
let mongoMockLogs = [];


const rutaOfflineDb = path.join(__dirname, process.env.SQLITE_OFFLINE_DB || "la_estacion_offline.db");
const offlineDb = new sqlite3.Database(rutaOfflineDb, (err) => {
  if (err) {
    console.error("Error al conectar SQLite offline:", err.message);
  } else {
    console.log("Base de datos SQLite offline conectada:", rutaOfflineDb);
  }
});

// Inicializar SQLite Offline Queue
offlineDb.serialize(() => {
  offlineDb.run(`
    CREATE TABLE IF NOT EXISTS local_sync_queue (
      id TEXT PRIMARY KEY,
      tipo_operacion TEXT NOT NULL,
      datos TEXT NOT NULL,
      fecha TEXT NOT NULL,
      estado TEXT NOT NULL,
      intentos INTEGER DEFAULT 0
    )
  `);
});

// ==========================================
// 1. CONEXIÓN A POSTGRESQL (CON FALLBACK SQLITE MOCK)
// ==========================================
async function conectarPostgres() {
  const pgUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL_PG;
  if (!pgUrl) {
    console.warn("⚠️ [PG WARNING] No se detectó DATABASE_URL_PG en el archivo .env. Iniciando en modo emulador SQLite.");
    activarPgMock();
    return;
  }

  try {
    pgPool = new Pool({
      connectionString: pgUrl,
      ssl: { rejectUnauthorized: false } // Requerido para Supabase/Neon en la nube
    });
    // Validar la conexión
    await pgPool.query("SELECT NOW()");
    console.log("✅ PostgreSQL en la nube conectado exitosamente.");
    await inicializarTablasPostgres();
  } catch (error) {
    console.error("❌ Error de conexión a PostgreSQL. Iniciando en modo emulador SQLite. Error:", error.message);
    activarPgMock();
  }
}

function activarPgMock() {
  isPgMock = true;
  const mockPath = path.join(__dirname, process.env.SQLITE_MOCK_DB || "la_estacion_SQLITE.db");
  pgMockDb = new sqlite3.Database(mockPath, (err) => {
    if (err) {
      console.error("Error al inicializar SQLite mock de Postgres:", err.message);
    } else {
      console.log("💾 Emulador SQLite de PostgreSQL conectado:", mockPath);
      inicializarTablasPgMock();
    }
  });
}

// ==========================================
// 2. CONEXIÓN A MONGODB (CON FALLBACK MOCK)
// ==========================================
async function conectarMongo() {
  const mongoUrl = process.env.MONGODB_URL || process.env.DATABASE_URL_MONGO;
  if (!mongoUrl) {
    console.warn("⚠️ [MONGO WARNING] No se detectó DATABASE_URL_MONGO en el archivo .env. Usando emulador de logs local (logs.json).");
    isMongoMock = true;
    return;
  }

  try {
    await mongoose.connect(mongoUrl);
    console.log("✅ MongoDB Atlas conectado exitosamente.");
  } catch (error) {
    console.error("❌ Error de conexión a MongoDB. Usando emulador de logs. Error:", error.message);
    isMongoMock = true;
  }
}

// Modelos de MongoDB (si MongoDB está activo)
const LogAuditoriaSchema = new mongoose.Schema({
  fecha: { type: Date, default: Date.now },
  id_usuario: String,
  correo_usuario: String,
  rol: String,
  sede_id: String,
  accion: String, // 'LOGIN', 'CONFIRMAR_COMPRA', 'PREPARAR_PEDIDO', 'ANULAR_COMPRA', 'SYNC_OFFLINE'
  detalle: mongoose.Schema.Types.Mixed
});

const SnapshotDiarioSchema = new mongoose.Schema({
  fecha: { type: Date, default: Date.now },
  sede_id: String,
  recursos: [{
    id_recurso: Number,
    nombre: String,
    stock_actual: Number,
    precio_compra: Number
  }]
});

const LogAuditoria = mongoose.models.LogAuditoria || mongoose.model("LogAuditoria", LogAuditoriaSchema);
const SnapshotDiario = mongoose.models.SnapshotDiario || mongoose.model("SnapshotDiario", SnapshotDiarioSchema);

// Función para guardar auditoría
async function registrarAuditoria(datos) {
  if (isMongoMock) {
    const logItem = { fecha: new Date(), ...datos };
    mongoMockLogs.unshift(logItem);
    const logsPath = path.join(__dirname, "mongo_logs_mock.json");
    fs.writeFileSync(logsPath, JSON.stringify(mongoMockLogs.slice(0, 100), null, 2));
    console.log("[MONGO MOCK AUDIT]", datos.accion, datos.detalle);
  } else {
    try {
      const nuevoLog = new LogAuditoria(datos);
      await nuevoLog.save();
    } catch (err) {
      console.error("Error al guardar auditoría en MongoDB:", err.message);
    }
  }
}

// ==========================================
// 3. ESTRUCTURA DE TABLAS POSTGRESQL (REAL)
// ==========================================
async function inicializarTablasPostgres() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS usuarios (
      id_usuario SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      correo TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      tipo TEXT NOT NULL, -- 'Administrador', 'Almacenero', 'Cajero'
      id_sede TEXT NOT NULL -- 'Sede Norte', 'Sede Sur'
    )`,
    `CREATE TABLE IF NOT EXISTS recursos (
      id_recurso SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL, -- 'Ingredientes', 'Bebidas', 'Empaques', 'Insumos'
      unidad_medida TEXT NOT NULL, -- 'gramo', 'mililitro', 'unidad'
      stock_minimo REAL DEFAULT 0,
      stock_actual REAL DEFAULT 0,
      precio_compra REAL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS productos (
      id_producto SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      tipo TEXT NOT NULL, -- 'Preparado', 'Directo'
      recurso_directo_id INTEGER REFERENCES recursos(id_recurso) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS recetas (
      id_receta SERIAL PRIMARY KEY,
      producto_id INTEGER REFERENCES productos(id_producto) ON DELETE CASCADE,
      recurso_id INTEGER REFERENCES recursos(id_recurso) ON DELETE CASCADE,
      cantidad_necesaria REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS lotes (
      id_lote SERIAL PRIMARY KEY,
      recurso_id INTEGER REFERENCES recursos(id_recurso) ON DELETE CASCADE,
      cantidad REAL NOT NULL,
      fecha_vencimiento DATE NOT NULL,
      codigo_lote TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS compras (
      id_compra SERIAL PRIMARY KEY,
      proveedor TEXT NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total REAL DEFAULT 0,
      estado TEXT NOT NULL -- 'Borrador', 'Confirmado', 'Anulado'
    )`,
    `CREATE TABLE IF NOT EXISTS compras_detalles (
      id_detalle SERIAL PRIMARY KEY,
      compra_id INTEGER REFERENCES compras(id_compra) ON DELETE CASCADE,
      recurso_id INTEGER REFERENCES recursos(id_recurso) ON DELETE CASCADE,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      fecha_vencimiento DATE
    )`,
    `CREATE TABLE IF NOT EXISTS pedidos (
      id_pedido SERIAL PRIMARY KEY,
      cliente TEXT NOT NULL,
      direccion TEXT NOT NULL,
      telefono TEXT NOT NULL,
      total REAL NOT NULL,
      estado TEXT NOT NULL, -- 'Registrado', 'Confirmado', 'En preparación', 'Listo para despacho', 'En camino', 'Entregado', 'Cancelado', 'Rechazado'
      sede_id TEXT NOT NULL, -- 'Sede Norte', 'Sede Sur'
      tipo_pago TEXT NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pedidos_detalles (
      id_detalle SERIAL PRIMARY KEY,
      pedido_id INTEGER REFERENCES pedidos(id_pedido) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id_producto) ON DELETE CASCADE,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS kardex (
      id_kardex SERIAL PRIMARY KEY,
      recurso_id INTEGER REFERENCES recursos(id_recurso) ON DELETE CASCADE,
      tipo_movimiento TEXT NOT NULL, -- 'Compra', 'Pedido', 'Merma', 'Ajuste', 'Rollback'
      cantidad REAL NOT NULL,
      saldo_anterior REAL NOT NULL,
      saldo_nuevo REAL NOT NULL,
      documento_origen TEXT NOT NULL, -- 'COMP-01', 'PED-12', etc.
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      id_usuario INTEGER,
      sede_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS alertas (
      id_alerta SERIAL PRIMARY KEY,
      tipo_alerta TEXT NOT NULL, -- 'stock_minimo', 'stock_agotado', 'proximo_vencer', 'producto_vencido'
      recurso_id INTEGER REFERENCES recursos(id_recurso) ON DELETE CASCADE,
      mensaje TEXT NOT NULL,
      estado TEXT NOT NULL, -- 'Pendiente', 'Resuelta'
      prioridad TEXT NOT NULL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const q of queries) {
    await pgPool.query(q);
  }

  // Insertar semillas si no hay registros
  const userCountRes = await pgPool.query("SELECT COUNT(*) FROM usuarios");
  if (parseInt(userCountRes.rows[0].count) === 0) {
    console.log("Sembrando datos iniciales en PostgreSQL...");
    // Usuarios por defecto (Password: estaci0n)
    await pgPool.query(`
      INSERT INTO usuarios (nombre, correo, password, tipo, id_sede) VALUES
      ('Admin General', 'admin@estacion.com', 'estaci0n', 'Administrador', 'Sede Norte'),
      ('Almacenero Norte', 'almacenero@estacion.com', 'estaci0n', 'Almacenero', 'Sede Norte'),
      ('Cajero Sur', 'cajero@estacion.com', 'estaci0n', 'Cajero', 'Sede Sur')
    `);

    // Recursos
    await pgPool.query(`
      INSERT INTO recursos (nombre, categoria, unidad_medida, stock_minimo, stock_actual, precio_compra) VALUES
      ('Carne de Hamburguesa 150g', 'Ingredientes', 'unidad', 20, 50, 4.50),
      ('Pan de Hamburguesa con Ajonjolí', 'Ingredientes', 'unidad', 20, 50, 0.80),
      ('Papas Cortadas para Freír', 'Ingredientes', 'gramo', 5000, 15000, 0.005),
      ('Alitas de Pollo Crudas', 'Ingredientes', 'unidad', 30, 80, 1.20),
      ('Gaseosa Inca Kola 500ml', 'Bebidas', 'unidad', 15, 30, 2.00),
      ('Agua San Mateo 500ml', 'Bebidas', 'unidad', 10, 20, 1.50),
      ('Caja Hamburguesa Cartón', 'Empaques', 'unidad', 20, 60, 0.40)
    `);

    // Productos
    await pgPool.query(`
      INSERT INTO productos (nombre, precio, tipo, recurso_directo_id) VALUES
      ('Hamburguesa Clásica con Papas', 16.90, 'Preparado', NULL),
      ('Porción de Alitas BBQ x6', 14.50, 'Preparado', NULL),
      ('Inca Kola 500ml', 3.50, 'Directo', 5),
      ('Agua San Mateo 500ml', 2.50, 'Directo', 6)
    `);

    // Recetas
    await pgPool.query(`
      INSERT INTO recetas (producto_id, recurso_id, cantidad_necesaria) VALUES
      (1, 1, 1),   -- Hamburguesa: 1 Carne
      (1, 2, 1),   -- Hamburguesa: 1 Pan
      (1, 3, 150), -- Hamburguesa: 150g Papas
      (1, 7, 1),   -- Hamburguesa: 1 Caja
      (2, 4, 6),   -- Alitas x6: 6 Alitas
      (2, 7, 1)    -- Alitas x6: 1 Caja
    `);
  }
}

// ==========================================
// 4. ESTRUCTURA DE TABLAS SQLITE MOCK (LOCAL FALLBACK)
// ==========================================
function dbRunAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAllAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGetAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function inicializarTablasPgMock() {
  const schemas = [
    `CREATE TABLE IF NOT EXISTS usuarios (
      id_usuario INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      correo TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      tipo TEXT NOT NULL,
      id_sede TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS recursos (
      id_recurso INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL,
      unidad_medida TEXT NOT NULL,
      stock_minimo REAL DEFAULT 0,
      stock_actual REAL DEFAULT 0,
      precio_compra REAL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS productos (
      id_producto INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      tipo TEXT NOT NULL,
      recurso_directo_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS recetas (
      id_receta INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER,
      recurso_id INTEGER,
      cantidad_necesaria REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS lotes (
      id_lote INTEGER PRIMARY KEY AUTOINCREMENT,
      recurso_id INTEGER,
      cantidad REAL NOT NULL,
      fecha_vencimiento TEXT NOT NULL,
      codigo_lote TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS compras (
      id_compra INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor TEXT NOT NULL,
      fecha TEXT DEFAULT CURRENT_TIMESTAMP,
      total REAL DEFAULT 0,
      estado TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS compras_detalles (
      id_detalle INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      recurso_id INTEGER,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      fecha_vencimiento TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pedidos (
      id_pedido INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL,
      direccion TEXT NOT NULL,
      telefono TEXT NOT NULL,
      total REAL NOT NULL,
      estado TEXT NOT NULL,
      sede_id TEXT NOT NULL,
      tipo_pago TEXT NOT NULL,
      fecha TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pedidos_detalles (
      id_detalle INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      producto_id INTEGER,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS kardex (
      id_kardex INTEGER PRIMARY KEY AUTOINCREMENT,
      recurso_id INTEGER,
      tipo_movimiento TEXT NOT NULL,
      cantidad REAL NOT NULL,
      saldo_anterior REAL NOT NULL,
      saldo_nuevo REAL NOT NULL,
      documento_origen TEXT NOT NULL,
      fecha TEXT DEFAULT CURRENT_TIMESTAMP,
      id_usuario INTEGER,
      sede_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS alertas (
      id_alerta INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_alerta TEXT NOT NULL,
      recurso_id INTEGER,
      mensaje TEXT NOT NULL,
      estado TEXT NOT NULL,
      prioridad TEXT NOT NULL,
      fecha TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  pgMockDb.serialize(async () => {
    for (const schema of schemas) {
      pgMockDb.run(schema);
    }

    const row = await dbGetAsync(pgMockDb, "SELECT COUNT(*) as count FROM usuarios");
    if (row.count === 0) {
      console.log("Sembrando datos iniciales en Emulador SQLite...");
      
      await dbRunAsync(pgMockDb, `
        INSERT INTO usuarios (nombre, correo, password, tipo, id_sede) VALUES
        ('Admin General', 'admin@estacion.com', 'estaci0n', 'Administrador', 'Sede Norte'),
        ('Almacenero Norte', 'almacenero@estacion.com', 'estaci0n', 'Almacenero', 'Sede Norte'),
        ('Cajero Sur', 'cajero@estacion.com', 'estaci0n', 'Cajero', 'Sede Sur')
      `);

      await dbRunAsync(pgMockDb, `
        INSERT INTO recursos (nombre, categoria, unidad_medida, stock_minimo, stock_actual, precio_compra) VALUES
        ('Carne de Hamburguesa 150g', 'Ingredientes', 'unidad', 20, 50, 4.50),
        ('Pan de Hamburguesa con Ajonjolí', 'Ingredientes', 'unidad', 20, 50, 0.80),
        ('Papas Cortadas para Freír', 'Ingredientes', 'gramo', 5000, 15000, 0.005),
        ('Alitas de Pollo Crudas', 'Ingredientes', 'unidad', 30, 80, 1.20),
        ('Gaseosa Inca Kola 500ml', 'Bebidas', 'unidad', 15, 30, 2.00),
        ('Agua San Mateo 500ml', 'Bebidas', 'unidad', 10, 20, 1.50),
        ('Caja Hamburguesa Cartón', 'Empaques', 'unidad', 20, 60, 0.40)
      `);

      await dbRunAsync(pgMockDb, `
        INSERT INTO productos (nombre, precio, tipo, recurso_directo_id) VALUES
        ('Hamburguesa Clásica con Papas', 16.90, 'Preparado', NULL),
        ('Porción de Alitas BBQ x6', 14.50, 'Preparado', NULL),
        ('Inca Kola 500ml', 3.50, 'Directo', 5),
        ('Agua San Mateo 500ml', 2.50, 'Directo', 6)
      `);

      await dbRunAsync(pgMockDb, `
        INSERT INTO recetas (producto_id, recurso_id, cantidad_necesaria) VALUES
        (1, 1, 1),
        (1, 2, 1),
        (1, 3, 150),
        (1, 7, 1),
        (2, 4, 6),
        (2, 7, 1)
      `);
    }
  });
}

// ==========================================
// 5. MÉTODOS DE CONSULTA COMPATIBLES (INTERFAZ DE DB)
// ==========================================
async function ejecutarQuery(sql, params = []) {
  if (!isPgMock) {
    const res = await pgPool.query(sql.replace(/\?/g, (match, index, fullText) => {
      let count = 0;
      for (let i = 0; i < fullText.length; i++) {
        if (i > index) break;
        if (fullText[i] === "?") count++;
      }
      return `$${count}`;
    }), params);
    return { rows: res.rows, rowCount: res.rowCount, lastID: res.rows[0]?.id_usuario || res.rows[0]?.id_compra || res.rows[0]?.id_pedido || null };
  } else {
    const upperSql = sql.trim().toUpperCase();
    if (upperSql.startsWith("INSERT")) {
      return new Promise((resolve, reject) => {
        pgMockDb.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve({ rows: [], rowCount: 1, lastID: this.lastID });
        });
      });
    } else {
      const rows = await dbAllAsync(pgMockDb, sql, params);
      return { rows, rowCount: rows.length, lastID: null };
    }
  }
}

// Iniciar conexiones
conectarPostgres();
conectarMongo();

module.exports = {
  ejecutarQuery,
  registrarAuditoria,
  offlineDb,
  isPgMock,
  isMongoMock
};
