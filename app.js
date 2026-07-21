const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && window.location.port !== "3000"
  ? "http://localhost:3000"
  : "";



function obtenerUsuarioSesion() {
  const sesion = localStorage.getItem("usuario_sesion");
  return sesion ? JSON.parse(sesion) : null;
}


function guardarUsuarioSesion(usuario) {
  localStorage.setItem("usuario_sesion", JSON.stringify(usuario));
}


function cerrarSesion() {
  localStorage.removeItem("usuario_sesion");
  window.location.href = "login.html";
}

function validarAcceso(rolesPermitidos = []) {
  const usuario = obtenerUsuarioSesion();
  if (!usuario) {
    window.location.href = "login.html";
    return null;
  }
  
  if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(usuario.tipo)) {
    alert("No tienes permisos para acceder a esta sección.");
    window.location.href = "dashboard.html";
    return null;
  }
  
  return usuario;
}


async function enviarPeticion(url, opciones = {}) {
  try {
    const respuesta = await fetch(url, {
      ...opciones,
      headers: {
        "Content-Type": "application/json",
        ...(opciones.headers || {})
      }
    });
    
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      throw new Error(datos.mensaje || "Ocurrió un error en la solicitud");
    }
    return datos;
  } catch (error) {
    console.error("Error en enviarPeticion:", error);
    throw error;
  }
}


document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector("header");
  const footer = document.querySelector("footer");
  const usuario = obtenerUsuarioSesion();

  if (header) {
   
    let navHtml = "";
    if (!usuario) {
      navHtml = `
        <a href="index.html">Inicio</a>
        <a href="login.html">Iniciar Sesión</a>
        <a href="registrar.html">Registrarse</a>
      `;
    } else {
      navHtml += `<a href="dashboard.html">Dashboard</a>`;
      
      if (usuario.tipo === "Administrador") {
        navHtml += `
          <a href="kardex.html">Kardex</a>
          <a href="registrar.html">Crear Usuario</a>
        `;
      } else if (usuario.tipo === "Almacenero") {
        navHtml += `
          <a href="compras.html">Compras</a>
          <a href="kardex.html">Kardex</a>
        `;
      } else if (usuario.tipo === "Cajero") {
        navHtml += `
          <a href="form_pedido.html">Nuevo Pedido</a>
          <a href="pedidos.html">Pedidos</a>
        `;
      }
      
      navHtml += `<a href="#" onclick="cerrarSesion()">Cerrar Sesión</a>`;
    }

    const badgeHtml = usuario 
      ? `<div class="user-badge ${usuario.tipo}">
          <span class="role-dot"></span>
          <strong>${usuario.nombre}</strong> (${usuario.tipo} - ${usuario.id_sede})
         </div>`
      : "";

    header.innerHTML = `
      <div class="logo-container">
        <img src="img/image.png" alt="Logo La Estación" onerror="this.src='https://cdn-icons-png.flaticon.com/512/3075/3075977.png'">
        <div class="encabezado-texto">
          <h1>La Estación</h1>
          <p>Sistema de Gestión de Inventarios (SGI)</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
      ${badgeHtml}
    `;

  
    const currentPath = window.location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("header nav a").forEach(link => {
      if (link.getAttribute("href") === currentPath) {
        link.classList.add("active");
      }
    });
  }

  if (footer) {
    footer.innerHTML = `
      <p>&copy; 2026 La Estación - SGI. Todos los derechos reservados.</p>
      <p>Contacto: U24266577@utp.edu.pe | Redes Sociales: Facebook | Instagram | TikTok</p>
    `;
  }
});


function obtenerQueueOffline() {
  return JSON.parse(localStorage.getItem("sqlite_sync_queue") || "[]");
}

function guardarQueueOffline(queue) {
  localStorage.setItem("sqlite_sync_queue", JSON.stringify(queue));
}

function encolarPedidoOffline(pedido) {
  const queue = obtenerQueueOffline();
  const uuid = "offline-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
  
  const operacion = {
    id: uuid,
    tipo_operacion: "CREAR_PEDIDO",
    datos: {
      ...pedido,
      id_usuario: obtenerUsuarioSesion()?.id_usuario || 999
    },
    fecha: new Date().toISOString(),
    estado: "Pendiente",
    intentos: 0
  };
  
  queue.push(operacion);
  guardarQueueOffline(queue);
  return uuid;
}
