require("dotenv").config();
const express = require("express");
const db = require("./database");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.static(__dirname));

app.post("/api/auth/login", async (req, res) => {
  const { correo, password } = req.body;
  if (!correo || !password) {
    return res.status(400).json({ mensaje: "Correo y contraseña requeridos" });
  }

  try {
    const result = await db.ejecutarQuery(
      "SELECT id_usuario, nombre, correo, password, tipo, id_sede FROM usuarios WHERE correo = ?",
      [correo]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ mensaje: "Usuario no registrado" });
    }

    const usuario = result.rows[0];
    if (usuario.password !== password) {
      return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    }

    await db.registrarAuditoria({
      id_usuario: usuario.id_usuario.toString(),
      correo_usuario: usuario.correo,
      rol: usuario.tipo,
      sede_id: usuario.id_sede,
      accion: "LOGIN",
      detalle: { mensaje: "Inicio de sesión exitoso" }
    });

    delete usuario.password;
    res.json({ mensaje: "Inicio de sesión exitoso", usuario });
  } catch (error) {
    res.status(500).json({ mensaje: "Error del servidor", error: error.message });
  }
});

app.post("/api/auth/registrar", async (req, res) => {
  const { nombre, correo, password, tipo, id_sede } = req.body;
  if (!nombre || !correo || !password || !tipo || !id_sede) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  try {
    const result = await db.ejecutarQuery(
      "INSERT INTO usuarios (nombre, correo, password, tipo, id_sede) VALUES (?, ?, ?, ?, ?) RETURNING id_usuario",
      [nombre, correo, password, tipo, id_sede]
    );

    const nuevoId = result.lastID || (result.rows[0] ? result.rows[0].id_usuario : null);

    res.status(201).json({ mensaje: "Usuario registrado con éxito", id: nuevoId });
  } catch (error) {
    if (error.message.includes("UNIQUE") || error.message.includes("duplicate key")) {
      return res.status(400).json({ mensaje: "El correo ya está registrado" });
    }
    res.status(500).json({ mensaje: "Error del servidor", error: error.message });
  }
});

app.get("/api/auth/usuarios", async (req, res) => {
  try {
    const result = await db.ejecutarQuery("SELECT id_usuario, nombre, correo, tipo, id_sede FROM usuarios");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error del servidor", error: error.message });
  }
});


app.get("/api/recursos", async (req, res) => {
  try {
    const result = await db.ejecutarQuery("SELECT * FROM recursos ORDER BY id_recurso ASC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener recursos", error: error.message });
  }
});

app.get("/api/productos", async (req, res) => {
  try {
    const result = await db.ejecutarQuery("SELECT * FROM productos ORDER BY id_producto ASC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener productos", error: error.message });
  }
});

app.get("/api/recetas", async (req, res) => {
  try {
    const result = await db.ejecutarQuery(`
      SELECT r.*, p.nombre as producto_nombre, rec.nombre as recurso_nombre 
      FROM recetas r 
      JOIN productos p ON r.producto_id = p.id_producto
      JOIN recursos rec ON r.recurso_id = rec.id_recurso
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener recetas", error: error.message });
  }
});

app.get("/api/compras", async (req, res) => {
  try {
    const comprasRes = await db.ejecutarQuery("SELECT * FROM compras ORDER BY id_compra DESC");
    const compras = comprasRes.rows;

    for (let i = 0; i < compras.length; i++) {
      const detallesRes = await db.ejecutarQuery(`
        SELECT cd.*, r.nombre as recurso_nombre, r.unidad_medida 
        FROM compras_detalles cd
        JOIN recursos r ON cd.recurso_id = r.id_recurso
        WHERE cd.compra_id = ?
      `, [compras[i].id_compra]);
      compras[i].detalles = detallesRes.rows;
    }

    res.json(compras);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener compras", error: error.message });
  }
});

app.post("/api/compras", async (req, res) => {
  const { proveedor, total, detalles } = req.body;
  if (!proveedor || !detalles || detalles.length === 0) {
    return res.status(400).json({ mensaje: "Datos de la compra incompletos" });
  }

  try {
    // Insertar compra en Borrador
    const compraRes = await db.ejecutarQuery(
      "INSERT INTO compras (proveedor, total, estado) VALUES (?, ?, 'Borrador') RETURNING id_compra",
      [proveedor, total]
    );
    const compraId = compraRes.lastID || (compraRes.rows[0] ? compraRes.rows[0].id_compra : null);

    for (const det of detalles) {
      await db.ejecutarQuery(
        "INSERT INTO compras_detalles (compra_id, recurso_id, cantidad, precio_unitario, fecha_vencimiento) VALUES (?, ?, ?, ?, ?)",
        [compraId, det.recurso_id, det.cantidad, det.precio_unitario, det.fecha_vencimiento || null]
      );
    }

    res.status(201).json({ mensaje: "Compra registrada en borrador", id_compra: compraId });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al registrar compra", error: error.message });
  }
});

app.post("/api/compras/:id/confirmar", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, sede_id } = req.body; // Para auditoría y Kardex

  try {
    // 1. Obtener datos de la compra
    const compraRes = await db.ejecutarQuery("SELECT * FROM compras WHERE id_compra = ?", [id]);
    if (compraRes.rowCount === 0) {
      return res.status(404).json({ mensaje: "Compra no encontrada" });
    }
    const compra = compraRes.rows[0];
    if (compra.estado !== "Borrador") {
      return res.status(400).json({ mensaje: "La compra ya fue confirmada o anulada" });
    }

    // 2. Obtener detalles
    const detallesRes = await db.ejecutarQuery("SELECT * FROM compras_detalles WHERE compra_id = ?", [id]);
    const detalles = detallesRes.rows;

    for (const det of detalles) {
      // Obtener stock actual para el Kardex
      const recursoRes = await db.ejecutarQuery("SELECT stock_actual, nombre FROM recursos WHERE id_recurso = ?", [det.recurso_id]);
      const recurso = recursoRes.rows[0];
      const stockAnterior = recurso.stock_actual;
      const stockNuevo = stockAnterior + det.cantidad;

      await db.ejecutarQuery(
        "UPDATE recursos SET stock_actual = ?, precio_compra = ? WHERE id_recurso = ?",
        [stockNuevo, det.precio_unitario, det.recurso_id]
      );

      await db.ejecutarQuery(
        "INSERT INTO kardex (recurso_id, tipo_movimiento, cantidad, saldo_anterior, saldo_nuevo, documento_origen, id_usuario, sede_id) VALUES (?, 'Compra', ?, ?, ?, ?, ?, ?)",
        [det.recurso_id, det.cantidad, stockAnterior, stockNuevo, `COMP-${id}`, id_usuario || null, sede_id || "Sede Norte"]
      );

      if (det.fecha_vencimiento) {
        await db.ejecutarQuery(
          "INSERT INTO lotes (recurso_id, cantidad, fecha_vencimiento, codigo_lote) VALUES (?, ?, ?, ?)",
          [det.recurso_id, det.cantidad, det.fecha_vencimiento, `LOTE-COMP-${id}`]
        );
      }

      if (stockNuevo > stockAnterior) {
        await db.ejecutarQuery(
          "UPDATE alertas SET estado = 'Resuelta' WHERE recurso_id = ? AND estado = 'Pendiente'",
          [det.recurso_id]
        );
      }
    }

    await db.ejecutarQuery("UPDATE compras SET estado = 'Confirmado' WHERE id_compra = ?", [id]);

    await db.registrarAuditoria({
      id_usuario: id_usuario?.toString(),
      rol: "Almacenero",
      sede_id: sede_id || "Sede Norte",
      accion: "CONFIRMAR_COMPRA",
      detalle: { compra_id: id, proveedor: compra.proveedor, total: compra.total, detalles }
    });

    res.json({ mensaje: "Compra confirmada, inventario y Kardex actualizados" });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al confirmar compra", error: error.message });
  }
});

app.post("/api/compras/:id/anular", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, sede_id } = req.body;

  try {
    const compraRes = await db.ejecutarQuery("SELECT * FROM compras WHERE id_compra = ?", [id]);
    if (compraRes.rowCount === 0) {
      return res.status(404).json({ mensaje: "Compra no encontrada" });
    }
    const compra = compraRes.rows[0];
    if (compra.estado !== "Confirmado") {
      return res.status(400).json({ mensaje: "Solo se pueden anular compras confirmadas" });
    }

    const detallesRes = await db.ejecutarQuery("SELECT * FROM compras_detalles WHERE compra_id = ?", [id]);
    const detalles = detallesRes.rows;

    for (const det of detalles) {
      const recursoRes = await db.ejecutarQuery("SELECT stock_actual, stock_minimo FROM recursos WHERE id_recurso = ?", [det.recurso_id]);
      const recurso = recursoRes.rows[0];
      const stockAnterior = recurso.stock_actual;
      const stockNuevo = Math.max(0, stockAnterior - det.cantidad);

      await db.ejecutarQuery("UPDATE recursos SET stock_actual = ? WHERE id_recurso = ?", [stockNuevo, det.recurso_id]);

      await db.ejecutarQuery(
        "INSERT INTO kardex (recurso_id, tipo_movimiento, cantidad, saldo_anterior, saldo_nuevo, documento_origen, id_usuario, sede_id) VALUES (?, 'Rollback', ?, ?, ?, ?, ?, ?)",
        [det.recurso_id, -det.cantidad, stockAnterior, stockNuevo, `RBK-COMP-${id}`, id_usuario || null, sede_id || "Sede Norte"]
      );

      await db.ejecutarQuery("DELETE FROM lotes WHERE recurso_id = ? AND codigo_lote = ?", [det.recurso_id, `LOTE-COMP-${id}`]);

      if (stockNuevo <= 0) {
        await db.ejecutarQuery(
          "INSERT INTO alertas (tipo_alerta, recurso_id, mensaje, estado, prioridad) VALUES ('stock_agotado', ?, ?, 'Pendiente', 'Alta')",
          [det.recurso_id, `Insumo agotado por anulación de compra COMP-${id}`]
        );
      } else if (stockNuevo <= recurso.stock_minimo) {
        await db.ejecutarQuery(
          "INSERT INTO alertas (tipo_alerta, recurso_id, mensaje, estado, prioridad) VALUES ('stock_minimo', ?, ?, 'Pendiente', 'Media')",
          [det.recurso_id, `Stock mínimo superado por anulación de compra COMP-${id}`]
        );
      }
    }

    await db.ejecutarQuery("UPDATE compras SET estado = 'Anulado' WHERE id_compra = ?", [id]);

    await db.registrarAuditoria({
      id_usuario: id_usuario?.toString(),
      rol: "Almacenero",
      sede_id: sede_id || "Sede Norte",
      accion: "ANULAR_COMPRA",
      detalle: { compra_id: id, total: compra.total, detalles }
    });

    res.json({ mensaje: "Compra anulada y Kardex reajustado correctamente" });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al anular compra", error: error.message });
  }
});

app.get("/api/pedidos", async (req, res) => {
  try {
    const pedidosRes = await db.ejecutarQuery("SELECT * FROM pedidos ORDER BY id_pedido DESC");
    const pedidos = pedidosRes.rows;

    for (let i = 0; i < pedidos.length; i++) {
      const detallesRes = await db.ejecutarQuery(`
        SELECT pd.*, p.nombre as producto_nombre 
        FROM pedidos_detalles pd
        JOIN productos p ON pd.producto_id = p.id_producto
        WHERE pd.pedido_id = ?
      `, [pedidos[i].id_pedido]);
      pedidos[i].detalles = detallesRes.rows;
    }

    res.json(pedidos);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener pedidos", error: error.message });
  }
});

app.post("/api/pedidos", async (req, res) => {
  const { cliente, direccion, telefono, total, sede_id, tipo_pago, detalles } = req.body;
  if (!cliente || !direccion || !telefono || !detalles || detalles.length === 0) {
    return res.status(400).json({ mensaje: "Datos del pedido incompletos" });
  }

  try {
    const pedidoRes = await db.ejecutarQuery(
      "INSERT INTO pedidos (cliente, direccion, telefono, total, estado, sede_id, tipo_pago) VALUES (?, ?, ?, ?, 'Registrado', ?, ?) RETURNING id_pedido",
      [cliente, direccion, telefono, total, sede_id, tipo_pago]
    );
    const pedidoId = pedidoRes.lastID || (pedidoRes.rows[0] ? pedidoRes.rows[0].id_pedido : null);

    for (const det of detalles) {
      await db.ejecutarQuery(
        "INSERT INTO pedidos_detalles (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)",
        [pedidoId, det.producto_id, det.cantidad, det.precio_unitario]
      );
    }

    res.status(201).json({ mensaje: "Pedido registrado correctamente", id_pedido: pedidoId });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al registrar pedido", error: error.message });
  }
});

app.post("/api/pedidos/:id/preparar", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, sede_id } = req.body;

  try {
    const pedidoRes = await db.ejecutarQuery("SELECT * FROM pedidos WHERE id_pedido = ?", [id]);
    if (pedidoRes.rowCount === 0) {
      return res.status(404).json({ mensaje: "Pedido no encontrado" });
    }
    const pedido = pedidoRes.rows[0];
    if (pedido.estado !== "Registrado" && pedido.estado !== "Confirmado") {
      return res.status(400).json({ mensaje: "El pedido ya está en preparación o fue despachado/cancelado" });
    }

    const detallesRes = await db.ejecutarQuery("SELECT * FROM pedidos_detalles WHERE pedido_id = ?", [id]);
    const detalles = detallesRes.rows;

    const insumosADescontar = {}; // id_recurso -> cantidad_total

    for (const det of detalles) {
      const productoRes = await db.ejecutarQuery("SELECT tipo, recurso_directo_id FROM productos WHERE id_producto = ?", [det.producto_id]);
      const producto = productoRes.rows[0];

      if (producto.tipo === "Directo") {
        const recId = producto.recurso_directo_id;
        insumosADescontar[recId] = (insumosADescontar[recId] || 0) + det.cantidad;
      } else {
        const recetaRes = await db.ejecutarQuery("SELECT recurso_id, cantidad_necesaria FROM recetas WHERE producto_id = ?", [det.producto_id]);
        const ingredientes = recetaRes.rows;

        for (const ing of ingredientes) {
          const recId = ing.recurso_id;
          insumosADescontar[recId] = (insumosADescontar[recId] || 0) + (ing.cantidad_necesaria * det.cantidad);
        }
      }
    }

    for (const recId in insumosADescontar) {
      const recursoRes = await db.ejecutarQuery("SELECT stock_actual, nombre FROM recursos WHERE id_recurso = ?", [recId]);
      const recurso = recursoRes.rows[0];
      if (recurso.stock_actual < insumosADescontar[recId]) {
        return res.status(400).json({
          mensaje: `Stock insuficiente para preparar el pedido. Falta ingrediente: ${recurso.nombre}. Stock actual: ${recurso.stock_actual}`
        });
      }
    }

    for (const recId in insumosADescontar) {
      const descuento = insumosADescontar[recId];
      const recursoRes = await db.ejecutarQuery("SELECT stock_actual, stock_minimo, nombre FROM recursos WHERE id_recurso = ?", [recId]);
      const recurso = recursoRes.rows[0];
      const stockAnterior = recurso.stock_actual;
      const stockNuevo = stockAnterior - descuento;

      await db.ejecutarQuery("UPDATE recursos SET stock_actual = ? WHERE id_recurso = ?", [stockNuevo, recId]);

      await db.ejecutarQuery(
        "INSERT INTO kardex (recurso_id, tipo_movimiento, cantidad, saldo_anterior, saldo_nuevo, documento_origen, id_usuario, sede_id) VALUES (?, 'Pedido', ?, ?, ?, ?, ?, ?)",
        [recId, -descuento, stockAnterior, stockNuevo, `PED-${id}`, id_usuario || null, sede_id || pedido.sede_id]
      );

      if (stockNuevo <= 0) {
        await db.ejecutarQuery(
          "INSERT INTO alertas (tipo_alerta, recurso_id, mensaje, estado, prioridad) VALUES ('stock_agotado', ?, ?, 'Pendiente', 'Alta')",
          [recId, `¡URGENTE! El recurso ${recurso.nombre} se ha agotado en inventario.`]
        );
      } else if (stockNuevo <= recurso.stock_minimo) {
        await db.ejecutarQuery(
          "INSERT INTO alertas (tipo_alerta, recurso_id, mensaje, estado, prioridad) VALUES ('stock_minimo', ?, ?, 'Pendiente', 'Media')",
          [recId, `Alerta: El recurso ${recurso.nombre} está por debajo del stock mínimo.`]
        );
      }
    }

    await db.ejecutarQuery("UPDATE pedidos SET estado = 'En preparación' WHERE id_pedido = ?", [id]);

    await db.registrarAuditoria({
      id_usuario: id_usuario?.toString(),
      rol: "Cajero",
      sede_id: sede_id || pedido.sede_id,
      accion: "PREPARAR_PEDIDO",
      detalle: { pedido_id: id, cliente: pedido.cliente, total: pedido.total, insumos_descontados: insumosADescontar }
    });

    res.json({ mensaje: "Pedido pasó a preparación. Inventario y Kardex actualizados por receta." });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al pasar pedido a preparación", error: error.message });
  }
});

app.post("/api/pedidos/:id/cancelar", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, sede_id } = req.body;

  try {
    const pedidoRes = await db.ejecutarQuery("SELECT * FROM pedidos WHERE id_pedido = ?", [id]);
    if (pedidoRes.rowCount === 0) {
      return res.status(404).json({ mensaje: "Pedido no encontrado" });
    }
    const pedido = pedidoRes.rows[0];

    if (pedido.estado === "Cancelado" || pedido.estado === "Entregado") {
      return res.status(400).json({ mensaje: "El pedido ya fue entregado o cancelado previamente" });
    }

    const estabaEnPreparacion = ["En preparación", "Listo para despacho", "En camino"].includes(pedido.estado);

    if (estabaEnPreparacion) {
      // Los ingredientes ya fueron descontados, por lo tanto, insertamos auditoría de merma
      await db.registrarAuditoria({
        id_usuario: id_usuario?.toString(),
        rol: "Cajero",
        sede_id: sede_id || pedido.sede_id,
        accion: "CANCELAR_PEDIDO_CON_MERMA",
        detalle: { pedido_id: id, cliente: pedido.cliente, total: pedido.total, nota: "Pedido cancelado después de preparación. Pérdida completa de ingredientes." }
      });

      const detallesRes = await db.ejecutarQuery("SELECT * FROM pedidos_detalles WHERE pedido_id = ?", [id]);
      for (const det of detallesRes.rows) {
        await db.ejecutarQuery(
          "INSERT INTO kardex (recurso_id, tipo_movimiento, cantidad, saldo_anterior, saldo_nuevo, documento_origen, id_usuario, sede_id) " +
          "SELECT recurso_id, 'Merma', 0, stock_actual, stock_actual, ?, ?, ? FROM recetas WHERE producto_id = ?",
          [`MER-PED-${id}`, id_usuario || null, sede_id || pedido.sede_id, det.producto_id]
        );
      }
    }

    await db.ejecutarQuery("UPDATE pedidos SET estado = 'Cancelado' WHERE id_pedido = ?", [id]);

    res.json({
      mensaje: estabaEnPreparacion
        ? "Pedido cancelado. Como ya estaba en preparación, los ingredientes se registraron como Merma."
        : "Pedido cancelado sin afectar inventario (aún no estaba en preparación)."
    });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al cancelar pedido", error: error.message });
  }
});

app.post("/api/pedidos/:id/cambiar-estado", async (req, res) => {
  const { id } = req.params;
  const { estado, id_usuario, sede_id } = req.body; // 'Confirmado', 'Listo para despacho', 'En camino', 'Entregado', 'Rechazado'

  if (!estado) {
    return res.status(400).json({ mensaje: "Estado requerido" });
  }

  try {
    const result = await db.ejecutarQuery("UPDATE pedidos SET estado = ? WHERE id_pedido = ?", [estado, id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ mensaje: "Pedido no encontrado" });
    }

    await db.registrarAuditoria({
      id_usuario: id_usuario?.toString(),
      rol: "Cajero",
      sede_id: sede_id || "Sede Norte",
      accion: "ESTADO_PEDIDO_" + estado.toUpperCase().replace(/ /g, "_"),
      detalle: { pedido_id: id, estado }
    });

    res.json({ mensaje: `Pedido actualizado a: ${estado}` });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al cambiar estado", error: error.message });
  }
});

app.get("/api/kardex", async (req, res) => {
  try {
    const result = await db.ejecutarQuery(`
      SELECT k.*, r.nombre as recurso_nombre, r.unidad_medida, u.nombre as usuario_nombre
      FROM kardex k
      JOIN recursos r ON k.recurso_id = r.id_recurso
      LEFT JOIN usuarios u ON k.id_usuario = u.id_usuario
      ORDER BY k.id_kardex DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener Kardex", error: error.message });
  }
});

app.get("/api/alertas", async (req, res) => {
  try {
    const result = await db.ejecutarQuery(`
      SELECT a.*, r.nombre as recurso_nombre, r.stock_actual
      FROM alertas a
      JOIN recursos r ON a.recurso_id = r.id_recurso
      WHERE a.estado = 'Pendiente'
      ORDER BY a.prioridad DESC, a.id_alerta DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener alertas", error: error.message });
  }
});

app.post("/api/alertas/:id/resolver", async (req, res) => {
  const { id } = req.params;
  try {
    await db.ejecutarQuery("UPDATE alertas SET estado = 'Resuelta' WHERE id_alerta = ?", [id]);
    res.json({ mensaje: "Alerta marcada como resuelta" });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al resolver alerta", error: error.message });
  }
});

app.get("/api/dashboard/stats", async (req, res) => {
  const { sede } = req.query; // Para filtrar por sede si aplica

  try {
    const totalPedidosRes = await db.ejecutarQuery("SELECT COUNT(*) as count, SUM(total) as ventas FROM pedidos WHERE estado != 'Cancelado'");
    const totalComprasRes = await db.ejecutarQuery("SELECT COUNT(*) as count, SUM(total) as compras FROM compras WHERE estado = 'Confirmado'");
    const alertasPendientesRes = await db.ejecutarQuery("SELECT COUNT(*) as count FROM alertas WHERE estado = 'Pendiente'");
    const stockBajoRes = await db.ejecutarQuery("SELECT COUNT(*) as count FROM recursos WHERE stock_actual <= stock_minimo");
    const mermasRes = await db.ejecutarQuery("SELECT COUNT(*) as count FROM kardex WHERE tipo_movimiento = 'Merma'");

    res.json({
      ventas: parseFloat(totalPedidosRes.rows[0].ventas || 0).toFixed(2),
      compras: parseFloat(totalComprasRes.rows[0].compras || 0).toFixed(2),
      cantidad_pedidos: totalPedidosRes.rows[0].count,
      cantidad_compras: totalComprasRes.rows[0].count,
      alertas_activas: alertasPendientesRes.rows[0].count,
      recursos_stock_bajo: stockBajoRes.rows[0].count,
      mermas_detectadas: mermasRes.rows[0].count
    });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al calcular estadísticas", error: error.message });
  }
});

app.post("/api/sync", async (req, res) => {
  const { operaciones } = req.body;
  if (!operaciones || !Array.isArray(operaciones)) {
    return res.status(400).json({ mensaje: "Array de operaciones requerido" });
  }

  const resultados = [];

  for (const op of operaciones) {
    try {
      if (op.tipo_operacion === "CREAR_PEDIDO") {
        // Registrar el pedido offline directamente en Postgres
        const { cliente, direccion, telefono, total, sede_id, tipo_pago, detalles, id_usuario } = op.datos;

        const pedidoRes = await db.ejecutarQuery(
          "INSERT INTO pedidos (cliente, direccion, telefono, total, estado, sede_id, tipo_pago) VALUES (?, ?, ?, ?, 'Registrado', ?, ?) RETURNING id_pedido",
          [cliente, direccion, telefono, total, sede_id, tipo_pago]
        );
        const pedidoId = pedidoRes.lastID || (pedidoRes.rows[0] ? pedidoRes.rows[0].id_pedido : null);

        for (const det of detalles) {
          await db.ejecutarQuery(
            "INSERT INTO pedidos_detalles (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)",
            [pedidoId, det.producto_id, det.cantidad, det.precio_unitario]
          );
        }

        await db.registrarAuditoria({
          id_usuario: id_usuario?.toString() || "Offline",
          rol: "Cajero",
          sede_id: sede_id || "Offline",
          accion: "SYNC_OFFLINE_PEDIDO",
          detalle: { uuid: op.id, pedido_id: pedidoId, cliente }
        });

        resultados.push({ uuid: op.id, estado: "Sincronizado", error: null });
      } else {
        resultados.push({ uuid: op.id, estado: "Ignorado", error: "Operación no soportada" });
      }
    } catch (err) {
      resultados.push({ uuid: op.id, estado: "Error", error: err.message });
    }
  }

  res.json({ mensaje: "Proceso de sincronización completado", resultados });
});

app.get("/api/logs", async (req, res) => {
  try {
    if (db.isMongoMock) {
      const fs = require("fs");
      const logsPath = path.join(__dirname, "mongo_logs_mock.json");
      if (fs.existsSync(logsPath)) {
        const fileContent = fs.readFileSync(logsPath, "utf-8");
        return res.json(JSON.parse(fileContent));
      }
      return res.json([]);
    } else {
      const mongoose = require("mongoose");
      const LogAuditoria = mongoose.model("LogAuditoria");
      const logs = await LogAuditoria.find().sort({ fecha: -1 }).limit(100);
      res.json(logs);
    }
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener logs", error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de La Estación SGI corriendo en: http://localhost:${PORT}`);
});