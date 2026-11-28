import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const STORAGE_KEY = "aniimo-account-session-v1";
const STAT_FIELDS = [
  { key: "pv", label: "PV", angle: -90 },
  { key: "atk", label: "ATQ", angle: -30 },
  { key: "def_f", label: "DEF-F", angle: 30 },
  { key: "regen", label: "REGEN", angle: 90 },
  { key: "def_m", label: "DEF-M", angle: 150 },
  { key: "rupture", label: "RUPTURA", angle: 210 }
];
const LOCALES = "en|ja|ko|tw|de|fr|es|pt|ru|id|th|vi";
const ASSET_ROOT = "_external/kg-web-cdn.akamaized.net/master/worldx/wiki-frontend/images/page/";
const secretKeySupplied = isSecretKey(SUPABASE_ANON_KEY);
const configured = /^https:\/\//.test(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) && !secretKeySupplied;

let session = readSession();
let currentUser = null;
let ownProfile = null;
let ownRows = [];
let profileMode = new URLSearchParams(location.search).has("profile");
let profileHandle = new URLSearchParams(location.search).get("profile") || "";
let viewingProfile = null;
let viewingRows = [];
let profileError = "";
let profilePanel = null;
let onlyOwned = false;
let onlyDuplicates = false;
let observedGrid = null;
let gridObserver = null;
let renderScheduled = false;
let toastTimer = 0;
let umbralsCatalogCache = null;
let variantImageCatalog = null;
let variantImageCatalogPromise = null;

function isSecretKey(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("sb_secret_")) return true;
  const payload = value.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return claims.role === "service_role";
  } catch {
    return false;
  }
}

function readSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    return saved?.access_token && saved?.refresh_token ? saved : null;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function saveSession(value) {
  session = {
    ...value,
    expires_at: Number(value.expires_at) ||
      Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600)
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  session = null;
  currentUser = null;
  ownProfile = null;
  ownRows = [];
  localStorage.removeItem(STORAGE_KEY);
  renderToolbar();
  renderGrid();
}

function baseUrl() {
  return SUPABASE_URL.replace(/\/+$/, "");
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function apiError(data, fallback) {
  return data?.msg || data?.message || data?.error_description || data?.error || fallback;
}

async function authRequest(path, body, token = SUPABASE_ANON_KEY, method = "POST") {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await responseData(response);
  if (!response.ok) throw new Error(apiError(data, `Supabase Auth error (${response.status})`));
  return data;
}

async function refreshSession() {
  if (!session?.refresh_token) throw new Error("Sua sessão expirou. Entre novamente.");
  try {
    const refreshed = await authRequest(
      "/auth/v1/token?grant_type=refresh_token",
      { refresh_token: session.refresh_token }
    );
    saveSession(refreshed);
  } catch (error) {
    clearSession();
    throw error;
  }
}

async function accessToken() {
  if (session?.refresh_token && session.expires_at <= Math.floor(Date.now() / 1000) + 60) {
    await refreshSession();
  }
  return session?.access_token || SUPABASE_ANON_KEY;
}

async function restRequest(path, options = {}, retried = false) {
  const token = await accessToken();
  const response = await fetch(`${baseUrl()}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const data = await responseData(response);
  if (response.status === 401 && session?.refresh_token && !retried) {
    await refreshSession();
    return restRequest(path, options, true);
  }
  if (!response.ok) throw new Error(apiError(data, `Supabase data error (${response.status})`));
  return data;
}

async function authUser(retried = false) {
  const token = await accessToken();
  const response = await fetch(`${baseUrl()}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  });
  const data = await responseData(response);
  if (response.status === 401 && session?.refresh_token && !retried) {
    await refreshSession();
    return authUser(true);
  }
  if (!response.ok) throw new Error(apiError(data, `Supabase Auth error (${response.status})`));
  return data;
}

function profileQuery(field, value) {
  const params = new URLSearchParams({ select: "id,username,collection_updated_at", [field]: `eq.${value}`, limit: "1" });
  return `profiles?${params}`;
}

async function findProfileById(id) {
  const rows = await restRequest(profileQuery("id", id));
  return rows?.[0] || null;
}

async function findProfileByUsername(username) {
  const rows = await restRequest(profileQuery("username", username.toLowerCase()));
  return rows?.[0] || null;
}

async function loadProfiles() {
  const params = new URLSearchParams({
    select: "id,username,created_at,collection_updated_at",
    order: "username.asc",
    limit: "500"
  });
  return restRequest(`profiles?${params}`);
}

async function loadCopies(userId) {
  const params = new URLSearchParams({
    select: "id,user_id,aniimo_key,aniimo_path,display_name,background_mode,pv,atk,def_f,regen,def_m,rupture,created_at",
    user_id: `eq.${userId}`,
    order: "created_at.asc"
  });
  return restRequest(`aniimo_copies?${params}`);
}

function showToast(message, isError = false) {
  document.querySelector(".account-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `account-toast${isError ? " is-error" : ""}`;
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.textContent = message;
  document.body.append(toast);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 4200);
}

function closeModal(modal) {
  modal?.remove();
}

function modalShell(content) {
  const modal = document.createElement("div");
  modal.className = "account-modal-backdrop";
  modal.innerHTML = content;
  modal.addEventListener("click", event => {
    if (event.target === modal || event.target.closest("[data-account-close]")) closeModal(modal);
  });
  document.addEventListener("keydown", function onEscape(event) {
    if (event.key === "Escape" && modal.isConnected) {
      closeModal(modal);
      document.removeEventListener("keydown", onEscape);
    }
  });
  document.body.append(modal);
  return modal;
}

function modalMessage(modal, text, success = false) {
  const target = modal.querySelector(".account-modal-message");
  if (!target) return;
  target.textContent = text;
  target.classList.toggle("is-success", success);
}

function openConfigurationDialog() {
  const modal = modalShell(`
    <section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-setup-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">×</button>
      <h2 id="account-setup-title">Configure as contas</h2>
      <p>Adicione a Project URL e a chave pública do Supabase em <code>supabase-config.js</code> e execute <code>supabase-schema.sql</code> no SQL Editor do projeto.</p>
      <p>Use somente a chave pública anon/publishable — nunca a chave <code>service_role</code>.</p>
      <p data-account-config-warning></p>
      <p><a href="SUPABASE_SETUP.md" target="_blank" rel="noopener">Ver instruções completas</a></p>
    </section>
  `);
  if (secretKeySupplied) {
    modal.querySelector("[data-account-config-warning]").textContent =
      "A chave configurada parece ser secreta e não será usada. Remova-a do arquivo e use a chave pública.";
  }
  modal.querySelector("[data-account-close]").focus();
}

function renderToolbar() {
  let toolbar = document.querySelector(".account-toolbar");
  if (!toolbar) {
    toolbar = document.createElement("nav");
    toolbar.className = "account-toolbar";
    toolbar.setAttribute("aria-label", "Conta e perfil");
    document.body.append(toolbar);
    toolbar.addEventListener("click", async event => {
      const action = event.target.closest("[data-account-action]")?.dataset.accountAction;
      if (!action) return;
      if (action === "account") {
        if (!configured) openConfigurationDialog();
        else if (currentUser && ownProfile) navigateToProfile(ownProfile.username);
        else openAuthModal();
      }
      if (action === "profile" && ownProfile) navigateToProfile(ownProfile.username);
      if (action === "directory") openProfileDirectory();
      if (action === "logout") await signOut();
    });
  }
  toolbar.replaceChildren();
  const account = document.createElement("button");
  account.type = "button";
  account.dataset.accountAction = "account";
  account.textContent = currentUser && ownProfile ? `@${ownProfile.username}` :
    configured ? "Entrar / criar conta" : "Configurar conta";
  toolbar.append(account);
  if (configured) {
    const directory = document.createElement("button");
    directory.type = "button";
    directory.dataset.accountAction = "directory";
    directory.textContent = "Usuarios";
    toolbar.append(directory);
  }
  if (currentUser && ownProfile) {
    const profile = document.createElement("button");
    profile.type = "button";
    profile.dataset.accountAction = "profile";
    profile.textContent = "Meu perfil";
    toolbar.append(profile);
    const logout = document.createElement("button");
    logout.type = "button";
    logout.dataset.accountAction = "logout";
    logout.textContent = "Sair";
    toolbar.append(logout);
  }
}

function openProfileDirectory() {
  if (!configured) {
    openConfigurationDialog();
    return;
  }
  const modal = modalShell(`
    <section class="account-modal account-directory-modal" role="dialog" aria-modal="true" aria-labelledby="account-directory-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">&times;</button>
      <h2 id="account-directory-title">Usuarios</h2>
      <p>Encontre uma colecao publica para visitar ou comparar repetidos.</p>
      <label class="account-directory-search">Buscar usuario
        <input type="search" data-directory-search placeholder="Nome de usuario" autocomplete="off">
      </label>
      <p class="account-modal-message" data-directory-message aria-live="polite"></p>
      <div class="account-directory-list" data-directory-list></div>
    </section>
  `);
  const list = modal.querySelector("[data-directory-list]");
  const message = modal.querySelector("[data-directory-message]");
  const search = modal.querySelector("[data-directory-search]");
  let profiles = [];
  const render = () => {
    const term = search.value.trim().toLowerCase();
    const matches = profiles.filter(profile => profile.username.includes(term));
    list.replaceChildren();
    if (!matches.length) {
      list.textContent = term ? "Nenhum usuario encontrado." : "Ainda nao ha usuarios para mostrar.";
      return;
    }
    for (const profile of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `@${profile.username}`;
      button.addEventListener("click", () => {
        closeModal(modal);
        navigateToProfile(profile.username);
      });
      list.append(button);
    }
  };
  search.addEventListener("input", render);
  search.focus();
  loadProfiles().then(rows => {
    profiles = rows || [];
    render();
  }).catch(error => { message.textContent = error.message; });
}

function openAuthModal() {
  if (!configured) {
    openConfigurationDialog();
    return;
  }
  const modal = modalShell(`
    <section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-auth-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">×</button>
      <h2 id="account-auth-title">Entrar na coleção</h2>
      <form class="account-form" novalidate>
        <label data-signup-field>Nome de usuário
          <input name="username" autocomplete="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}">
        </label>
        <label>E-mail
          <input name="email" type="email" autocomplete="email" required>
        </label>
        <label>Senha
          <input name="password" type="password" autocomplete="current-password" minlength="8" required>
        </label>
        <p class="account-modal-message" aria-live="polite"></p>
        <div class="account-modal-actions">
          <button type="submit" data-submit>Entrar</button>
          <button type="button" data-toggle-mode>Criar conta</button>
        </div>
      </form>
    </section>
  `);
  const form = modal.querySelector("form");
  const username = form.elements.username;
  const password = form.elements.password;
  const title = modal.querySelector("#account-auth-title");
  const submit = modal.querySelector("[data-submit]");
  const toggle = modal.querySelector("[data-toggle-mode]");
  let mode = "login";

  const updateMode = () => {
    const signup = mode === "signup";
    title.textContent = signup ? "Criar conta" : "Entrar na coleção";
    modal.querySelector("[data-signup-field]").hidden = !signup;
    username.required = signup;
    password.autocomplete = signup ? "new-password" : "current-password";
    submit.textContent = signup ? "Criar conta" : "Entrar";
    toggle.textContent = signup ? "Já tenho conta" : "Criar conta";
    modalMessage(modal, "");
  };

  toggle.addEventListener("click", () => {
    mode = mode === "login" ? "signup" : "login";
    updateMode();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    modalMessage(modal, "");
    const email = form.elements.email.value.trim();
    const passwordValue = form.elements.password.value;
    const usernameValue = form.elements.username.value.trim().toLowerCase();
    if (mode === "signup" && !/^[a-zA-Z0-9_]{3,24}$/.test(usernameValue)) {
      modalMessage(modal, "Use de 3 a 24 letras, números ou _ no nome de usuário.");
      return;
    }
    if (passwordValue.length < 8) {
      modalMessage(modal, "A senha deve ter pelo menos 8 caracteres.");
      return;
    }
    submit.disabled = true;
    try {
      if (mode === "signup") {
        const result = await authRequest("/auth/v1/signup", {
          email,
          password: passwordValue,
          data: { username: usernameValue }
        });
        if (result?.access_token) {
          await completeLogin(result);
          closeModal(modal);
          showToast("Conta criada.");
        } else {
          modalMessage(modal, "Conta criada. Confirme seu e-mail e depois entre.", true);
          mode = "login";
          updateMode();
          modalMessage(modal, "Conta criada. Confirme seu e-mail e depois entre.", true);
        }
      } else {
        const result = await authRequest("/auth/v1/token?grant_type=password", {
          email,
          password: passwordValue
        });
        await completeLogin(result);
        closeModal(modal);
        showToast("Login realizado.");
      }
    } catch (error) {
      modalMessage(modal, error.message, false);
    } finally {
      submit.disabled = false;
    }
  });
  updateMode();
  form.elements.email.focus();
}

async function completeLogin(value) {
  if (!value?.access_token || !value?.refresh_token) {
    throw new Error("O Supabase não retornou uma sessão válida.");
  }
  saveSession(value);
  await loadSignedInState();
}

async function loadSignedInState() {
  const user = await authUser();
  const profile = await findProfileById(user.id);
  if (!profile) throw new Error("Perfil não encontrado. Verifique a configuração do trigger no Supabase.");
  currentUser = user;
  ownProfile = profile;
  ownRows = await loadCopies(user.id);
  if (profileMode && viewingProfile?.id === profile.id) viewingRows = ownRows;
  renderToolbar();
  mountProfilePanel();
  renderGrid();
}

async function signOut() {
  try {
    if (session?.access_token && configured) {
      await authRequest("/auth/v1/logout", undefined, await accessToken());
    }
    clearSession();
    viewingRows = profileMode ? viewingRows : [];
    mountProfilePanel();
    showToast("Você saiu da conta.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function navigateToProfile(username) {
  const target = homeUrl();
  target.searchParams.set("profile", username);
  history.pushState({}, "", target.href);
  activateProfileRoute(username);
}

function navigateHome() {
  const target = homeUrl();
  location.assign(target.href);
}

function homeUrl() {
  const target = new URL("index.html", document.baseURI);
  target.search = "";
  target.hash = "";
  return target;
}

async function activateProfileRoute(username) {
  profileMode = true;
  profileHandle = username;
  viewingProfile = null;
  viewingRows = [];
  profileError = "";
  onlyOwned = false;
  onlyDuplicates = false;
  if (profilePanel?.isConnected) profilePanel.remove();
  profilePanel = null;
  mountProfilePanel();
  renderGrid();
  if (!configured) {
    profileError = "Configure o Supabase para carregar perfis públicos.";
    mountProfilePanel();
    return;
  }
  try {
    await enableVariantsForProfile();
    await loadPublicProfile();
  } catch (error) {
    profileError = error.message;
    mountProfilePanel();
    showToast(error.message, true);
  }
}

function canonicalPath(anchor) {
  return normalizeAniimoPath(anchor.getAttribute("href") || "") || "/";
}

function isNonUmbralsCard(anchor) {
  const path = canonicalPath(anchor);
  const name = anchor.querySelector(".text-center span")?.textContent || "";
  if (path === "/item/10007/basic-form/1000") return false;
  return path.includes("/prismana-") ||
    /\/1000(?:\/|$)/.test(path) ||
    /inferlobo|infergon/i.test(name);
}

function ensureJaguaraunUmbralCard(grid) {
  const jaguaraunPath = "/item/10007/basic-form/1000";
  const existing = [...grid.querySelectorAll(":scope > a.aniimo-item-container")]
    .find(card => canonicalPath(card) === jaguaraunPath);
  if (existing) return existing;

  const template = grid.querySelector(":scope > a.aniimo-item-container");
  if (!template) return null;
  const card = template.cloneNode(true);
  card.dataset.accountJaguaraun = "true";
  card.href = "https://wiki.aniimo.com/item/10007/basic-form/1000";
  card.querySelector(".aniimo-item-top-image > span")?.replaceChildren("NO.10007");
  const name = card.querySelector(".text-center span");
  if (name) name.textContent = "Jaguarraio";
  card.querySelectorAll(".aniimo-item-attribute-item").forEach(item => {
    item.className = item.className.replace(/attributes-[\w-]+/g, "attributes-electric");
  });
  card.querySelectorAll(".aniimo-item-position-item").forEach(item => {
    item.className = item.className.replace(/position-[\w-]+/g, "position-break");
  });
  grid.append(card);
  return card;
}

function backgroundMode(anchor) {
  if (profileMode && anchor.dataset.accountMode) return anchor.dataset.accountMode;
  return isNonUmbralsCard(anchor) ? "normal" : "umbrais";
}

function identityFor(anchor, mode = backgroundMode(anchor)) {
  const path = anchor.dataset.accountPath || canonicalPath(anchor);
  const name = anchor.querySelector(".text-center span")?.textContent?.trim() ||
    anchor.textContent.trim();
  return { path, mode, name, key: `${path}|${mode}` };
}

function assetUrl(name) {
  return new URL(`${ASSET_ROOT}${name}`, document.baseURI).href;
}

function setCardBackground(anchor, mode) {
  const image = anchor.querySelector(".aniimo-item-top-image");
  if (!image) return;
  const file = mode === "umbrais" ? "umbrais_bg.png" : "aniimo_bg.png";
  image.style.backgroundImage = `url("${assetUrl(file)}")`;
  anchor.dataset.accountMode = mode;
}

function clearCardControls(anchor) {
  anchor.querySelectorAll(".account-add-button, .account-remove-button, .account-count-badge").forEach(node => node.remove());
  delete anchor.dataset.accountUiAdd;
  delete anchor.dataset.accountUiRemove;
  delete anchor.dataset.accountUiCount;
}

function addCardControls(anchor, path, mode, copies, allowAdd) {
  clearCardControls(anchor);
  anchor.dataset.accountPath = path;
  anchor.dataset.accountMode = mode;
  anchor.dataset.accountUiAdd = String(allowAdd);
  anchor.dataset.accountUiRemove = String(allowAdd && copies.length > 0);
  anchor.dataset.accountUiCount = String(copies.length > 0);
  if (allowAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "account-add-button";
    add.dataset.accountAdd = "true";
    add.setAttribute("aria-label", `Adicionar ${identityFor(anchor, mode).name} à coleção`);
    add.textContent = "+";
    anchor.append(add);
  }
  if (allowAdd && copies.length) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "account-remove-button";
    remove.dataset.accountRemove = "true";
    remove.setAttribute("aria-label", `Remover uma cópia de ${identityFor(anchor, mode).name}`);
    remove.textContent = "−";
    anchor.append(remove);
  }
  if (copies.length) {
    const count = document.createElement("button");
    count.type = "button";
    count.className = "account-count-badge";
    count.dataset.accountCopies = "true";
    count.textContent = `${copies.length}×`;
    count.setAttribute("aria-label", `${copies.length} cópias. Gerenciar status inatos`);
    anchor.append(count);
  }
}

function rowsFor(path, mode, rows) {
  return rows.filter(row => row.aniimo_path === path && row.background_mode === mode);
}

function groupGridByAniimo(grid) {
  const cards = [...grid.querySelectorAll(":scope > a.aniimo-item-container:not([data-account-profile-clone])")];
  const regionOrder = new Map([
    ["300001", 0], // Planícies Ventosas
    ["300301", 1], // Ilhas Sussurrantes
    ["1000", 2] // Lembranças da Temporada 1
  ]);

  cards.forEach((card, sourceOrder) => {
    const path = canonicalPath(card);
    const entry = Number(path.match(/\/item\/(\d+)/)?.[1]) || 999;
    const country = path.match(/\/(\d+)$/)?.[1] || "300001";
    const region = regionOrder.get(country) ?? 100 + Number(country || 0);
    // Região → número do Aniimo → ordem original das formas/variações.
    card.style.order = String(region * 1_000_000 + entry * 1_000 + sourceOrder);
  });
}

function renderGrid() {
  if (!observedGrid) return;
  const grid = observedGrid;
  if (profileMode) mountProfilePanel();
  grid.querySelectorAll(":scope > [data-account-profile-clone]").forEach(node => node.remove());
  ensureJaguaraunUmbralCard(grid);
  groupGridByAniimo(grid);
  const cards = [...grid.querySelectorAll(":scope > a.aniimo-item-container:not([data-account-profile-clone])")];
  if (profileMode) {
    if (viewingProfile) {
      renderProfileCards(grid, cards);
    } else {
      for (const card of cards) {
        clearCardControls(card);
        card.hidden = false;
        card.classList.remove("account-not-owned");
      }
    }
    hideNonUmbralsFromUmbralsFilter();
    return;
  }
  for (const card of cards) {
    card.hidden = false;
    card.classList.remove("account-not-owned");
    const path = canonicalPath(card);
    const mode = backgroundMode(card);
    setCardBackground(card, mode);
    addCardControls(card, path, mode, rowsFor(path, mode, ownRows), true);
  }
  hideNonUmbralsFromUmbralsFilter();
}

function renderProfileCards(grid, cards) {
  const canEdit = currentUser?.id === viewingProfile.id;
  for (const card of cards) {
    const path = canonicalPath(card);
    const copies = viewingRows.filter(row => row.aniimo_path === path);
    const modes = [...new Set(copies.map(row => row.background_mode))];
    if (!modes.length) modes.push(backgroundMode(card));
    modes.forEach((mode, index) => {
      const target = index === 0 ? card : card.cloneNode(true);
      if (index > 0) {
        target.dataset.accountProfileClone = "true";
        target.classList.add("account-profile-clone");
        clearCardControls(target);
      }
      const ownedCopies = rowsFor(path, mode, viewingRows);
      const owned = ownedCopies.length > 0;
      target.hidden = (onlyOwned && !owned) || (onlyDuplicates && ownedCopies.length < 2);
      target.classList.toggle("account-not-owned", !owned);
      target.dataset.accountPath = path;
      setCardBackground(target, mode);
      addCardControls(target, path, mode, ownedCopies, canEdit);
      if (index > 0) card.after(target);
    });
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderGrid();
  });
}

function observeGrid(grid) {
  if (!grid || observedGrid === grid) return;
  gridObserver?.disconnect();
  observedGrid = grid;
  gridObserver = new MutationObserver(records => {
    const shouldRender = records.some(record => {
      if (record.target === grid) {
        return [...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType !== Node.ELEMENT_NODE || !node.matches("[data-account-profile-clone]")
        );
      }
      const card = record.target.closest?.(".aniimo-item-container");
      if (!card || card.dataset.accountProfileClone === "true") return false;
      return (card.dataset.accountUiAdd === "true" && !card.querySelector(".account-add-button")) ||
        (card.dataset.accountUiRemove === "true" && !card.querySelector(".account-remove-button")) ||
        (card.dataset.accountUiCount === "true" && !card.querySelector(".account-count-badge"));
    });
    if (shouldRender) scheduleRender();
  });
  gridObserver.observe(grid, { childList: true, subtree: true });
  scheduleRender();
}

function startGridObserver() {
  const observer = new MutationObserver(() => {
    observeGrid(document.querySelector(".aniimo-list-grid"));
    if (profileMode && observedGrid) mountProfilePanel();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observeGrid(document.querySelector(".aniimo-list-grid"));
}

function umbralsCatalogPaths() {
  if (umbralsCatalogCache) return new Set(umbralsCatalogCache);
  return new Set(
    [...document.querySelectorAll(".aniimo-list-grid > a.aniimo-item-container:not([data-account-profile-clone])")]
      .filter(card => !isNonUmbralsCard(card))
      .map(canonicalPath)
  );
}

function cacheUmbralsCatalogPaths() {
  umbralsCatalogCache = umbralsCatalogPaths();
}

function hideNonUmbralsFromUmbralsFilter() {
  const onlyUmbrals = document.querySelector(".aniimo-options-umbrals-show.is-selected");
  if (!onlyUmbrals) return;
  document.querySelectorAll(".aniimo-list-grid > a.aniimo-item-container").forEach(card => {
    if (isNonUmbralsCard(card)) card.hidden = true;
  });
}

function umbralsProgress(rows) {
  const catalog = umbralsCatalogPaths();
  const owned = new Set(
    rows
      .filter(row => row.background_mode === "umbrais")
      .map(row => normalizeAniimoPath(row.aniimo_path))
      .filter(path => catalog.has(path))
  );
  const total = catalog.size;
  const current = owned.size;
  return { current, total, percent: total ? Math.round(current / total * 100) : 0 };
}

function collectionUpdatedAtLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "sem atualizações";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function mountProfilePanel() {
  if (!profileMode || !observedGrid) return;
  if (!profilePanel || !profilePanel.isConnected) {
    profilePanel = document.createElement("section");
    profilePanel.className = "account-profile-panel";
    profilePanel.innerHTML = `
      <h2 data-profile-title>Perfil público</h2>
      <p data-profile-status aria-live="polite"></p>
      <label><input type="checkbox" data-only-owned> Mostrar apenas os Aniimos que tenho</label>
      <label><input type="checkbox" data-only-duplicates> Mostrar apenas repetidos</label>
      <button type="button" data-compare-duplicates hidden>Comparar repetidos</button>
      <button type="button" data-share-profile>Copiar link público</button>
      <button type="button" data-home>Voltar à página inicial</button>
      <div class="account-umbrals-progress" data-umbrals-progress>
        <span data-umbrals-progress-label></span>
        <div class="account-umbrals-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-umbrals-progress-track>
          <span class="account-umbrals-progress-fill" data-umbrals-progress-fill></span>
        </div>
      </div>
    `;
    document.body.prepend(profilePanel);
    profilePanel.querySelector("[data-only-owned]").addEventListener("change", event => {
      onlyOwned = event.target.checked;
      renderGrid();
    });
    profilePanel.querySelector("[data-only-duplicates]").addEventListener("change", event => {
      onlyDuplicates = event.target.checked;
      renderGrid();
    });
    profilePanel.querySelector("[data-compare-duplicates]").addEventListener("click", openDuplicateComparison);
    profilePanel.querySelector("[data-home]").addEventListener("click", navigateHome);
    profilePanel.querySelector("[data-share-profile]").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        showToast("Link público copiado.");
      } catch {
        showToast("Não foi possível copiar automaticamente. Copie o endereço do navegador.", true);
      }
    });
  }
  const title = profilePanel.querySelector("[data-profile-title]");
  const status = profilePanel.querySelector("[data-profile-status]");
  const titleText = viewingProfile ? `Coleção de @${viewingProfile.username}` : "Perfil público";
  const statusText = profileError || (viewingProfile
    ? `${viewingRows.length} Aniimos na coleção${currentUser?.id === viewingProfile.id ? " — este é o seu perfil" : ""}. Última atualização: ${collectionUpdatedAtLabel(viewingProfile.collection_updated_at)}.`
    : "Carregando perfil público…");
  if (title.textContent !== titleText) title.textContent = titleText;
  status.classList.toggle("account-profile-error", Boolean(profileError));
  if (status.textContent !== statusText) status.textContent = statusText;
  const compare = profilePanel.querySelector("[data-compare-duplicates]");
  compare.hidden = !currentUser || !viewingProfile || currentUser.id === viewingProfile.id;
  const progress = umbralsProgress(profileMode ? viewingRows : ownRows);
  const progressLabel = profilePanel.querySelector("[data-umbrals-progress-label]");
  const progressTrack = profilePanel.querySelector("[data-umbrals-progress-track]");
  const progressFill = profilePanel.querySelector("[data-umbrals-progress-fill]");
  const progressText = `Umbrais: ${progress.current}/${progress.total} (${progress.percent}%)`;
  if (progressLabel.textContent !== progressText) progressLabel.textContent = progressText;
  progressTrack.setAttribute("aria-valuenow", String(progress.percent));
  progressTrack.setAttribute("aria-label", `Progresso Umbrais: ${progress.current} de ${progress.total}`);
  const progressWidth = `${progress.percent}%`;
  if (progressFill.style.width !== progressWidth) progressFill.style.width = progressWidth;
}

function duplicateGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.aniimo_path}|${row.background_mode}`;
    const existing = groups.get(key) || {
      key,
      path: row.aniimo_path,
      mode: row.background_mode,
      name: row.display_name,
      count: 0
    };
    existing.count += 1;
    groups.set(key, existing);
  }
  return new Map([...groups].filter(([, group]) => group.count > 1));
}

let tradeCatalog = null;
let tradeCatalogByName = null;

function catalogForTrades() {
  if (tradeCatalog) return tradeCatalog;
  tradeCatalog = new Map();
  tradeCatalogByName = new Map();
  try {
    const source = document.querySelector("#__NUXT_DATA__")?.textContent;
    if (!source) return tradeCatalog;
    const flat = JSON.parse(source);
    const cache = new Map();
    const revive = index => {
      if (!Number.isInteger(index) || index < 0 || index >= flat.length) return index;
      if (cache.has(index)) return cache.get(index);
      const value = flat[index];
      if (!value || typeof value !== "object") return value;
      const result = Array.isArray(value) ? [] : {};
      cache.set(index, result);
      if (Array.isArray(value)) result.push(...value.map(revive));
      else for (const [key, child] of Object.entries(value)) result[key] = revive(child);
      return result;
    };
    const walk = (value, visited = new Set()) => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (value.type === "ANIIMO" && value.entryId && value.currentStage) {
        const variantSlug = String(value.currentMorphology || "Basic Form").trim().toLowerCase().replace(/\s+/g, "-");
        const key = `${String(value.entryId).padStart(3, "0")}/${variantSlug}`;
        tradeCatalog.set(key, value);
        if (value.name) tradeCatalogByName.set(value.name.trim().toLowerCase(), value);
        // fallback for entry without variant
        const baseKey = String(value.entryId).padStart(3, "0");
        if (!tradeCatalog.has(baseKey)) tradeCatalog.set(baseKey, value);
      }
      Object.values(value).forEach(child => walk(child, visited));
    };
    walk(revive(0));
  } catch (error) {
    console.warn("Não foi possível ler o catálogo para as sugestões de troca.", error);
  }
  return tradeCatalog;
}

function tradeDetails(group) {
  const match = group.path.match(/\/item\/(\d+)(?:\/([^/?#]+))?/);
  catalogForTrades();
  const entry = match ? match[1].padStart(3, "0") : null;
  const variant = match?.[2] ? match[2].toLowerCase() : null;
  if (entry && variant) {
    const exactKey = `${entry}/${variant}`;
    if (tradeCatalog.has(exactKey)) return tradeCatalog.get(exactKey);
    for (const value of tradeCatalog.values()) {
      if (String(value.entryId).padStart(3, "0") !== entry) continue;
      const morphSlug = String(value.currentMorphology || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (morphSlug === variant || morphSlug.includes(variant) || variant.includes(morphSlug)) return value;
    }
  }
  if (entry && tradeCatalog.has(entry)) return tradeCatalog.get(entry);
  return tradeCatalogByName.get(group.name.trim().toLowerCase()) || null;
}

function speciesKey(rowOrGroup) {
  const path = normalizeAniimoPath(rowOrGroup.aniimo_path || rowOrGroup.path || "");
  const match = path.match(/\/item\/(\d+)(?:\/([^/?#]+))?/i);
  if (match) {
    const entry = match[1].padStart(3, "0");
    const variant = match[2] ? match[2].toLowerCase() : "";
    return variant ? `${entry}/${variant}` : entry;
  }
  return rowOrGroup.aniimo_key || rowOrGroup.key;
}

function sharedCount(first = [], second = []) {
  return first.filter(value => second.includes(value)).length;
}

function tradeScore(mine, theirs) {
  if (mine.currentStage !== theirs.currentStage) return -Infinity;
  let score = 0;
  if (mine.countryId === theirs.countryId) score += 100;
  score += sharedCount(mine.attributes, theirs.attributes) * 10;
  score += sharedCount(mine.position, theirs.position) * 6;
  return score;
}

function variantLabel(group, info) {
  const match = group.path?.match(/\/item\/\d+\/([^/?#]+)/);
  if (match) return match[1].split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  return info?.currentMorphology || "Basic Form";
}

function variantImageKey(path) {
  const match = normalizeAniimoPath(path).match(/\/item\/(\d+)\/([^/?#]+)/);
  return match ? `${match[1].padStart(3, "0")}/${match[2]}` : "";
}

async function loadVariantImageCatalog() {
  if (variantImageCatalog) return variantImageCatalog;
  if (variantImageCatalogPromise) return variantImageCatalogPromise;
  const source = new URL(
    "/_external/kg-web-cdn.akamaized.net/master/worldx/wiki-frontend/_nuxt/aniimo-variants-pt.json",
    document.baseURI
  );
  variantImageCatalogPromise = fetch(source).then(async response => {
    if (!response.ok) throw new Error(`Não foi possível carregar imagens das variantes (${response.status}).`);
    const variants = await response.json();
    variantImageCatalog = new Map();
    for (const variant of variants) {
      const info = variant?.searchKey;
      const entry = String(info?.entryId || "").padStart(3, "0");
      const morphology = String(info?.currentMorphology || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (!entry || !morphology || !info?.imageUrl) continue;
      variantImageCatalog.set(
        `${entry}/${morphology}`,
        new URL(info.imageUrl, document.baseURI).href
      );
    }
    return variantImageCatalog;
  }).finally(() => { variantImageCatalogPromise = null; });
  return variantImageCatalogPromise;
}

function variantImageSrc(path) {
  return variantImageCatalog?.get(variantImageKey(path)) || "";
}

function normalizeAniimoPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const target = new URL(raw, location.href);
    const pathname = target.pathname
      .replace(new RegExp(`^/(${LOCALES})(?=/)`, "i"), "")
      .replace(/\/+$/, "");
    // Os hrefs da wiki são relativos. Em file://, URL os resolve sob o diretório
    // local (por exemplo, /C:/projeto/pt/item/034/...), não sob a raiz da wiki.
    const itemIndex = pathname.toLowerCase().indexOf("/item/");
    return (itemIndex >= 0 ? pathname.slice(itemIndex) : pathname).toLowerCase() || "/";
  } catch {
    const pathname = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const itemIndex = pathname.toLowerCase().indexOf("/item/");
    return (itemIndex >= 0 ? pathname.slice(itemIndex) : pathname).toLowerCase();
  }
}

function pathMatchScore(candidate, targetPath, exactScore, nestedScore) {
  if (candidate === targetPath) return exactScore;
  return candidate.startsWith(`${targetPath}/`) ? nestedScore : 0;
}

function cardPathMatchScore(card, targetPath) {
  const hrefPath = normalizeAniimoPath(card.getAttribute("href"));
  return pathMatchScore(hrefPath, targetPath, 2, 1);
}

function imageSource(img) {
  const source = img.getAttribute("src") || img.currentSrc || img.src ||
    img.getAttribute("data-src") || img.getAttribute("data-original") || "";
  return source && !/aniimo_bg\.png|umbrais_bg\.png/i.test(source)
    ? new URL(source, document.baseURI).href
    : "";
}

function imageSourceFromCard(card) {
  const covers = [...card.querySelectorAll("img.aniimo-info-cover")];
  const otherImages = [...card.querySelectorAll("img:not(.aniimo-info-cover)")];
  for (const img of [...covers, ...otherImages]) {
    const source = imageSource(img);
    if (source) return source;
  }
  return "";
}

function findCardImageSrc(path, mode) {
  const targetPath = normalizeAniimoPath(path);
  if (!targetPath) return "";
  const targetMode = String(mode || "").toLowerCase();
  const cards = [...document.querySelectorAll(".aniimo-list-grid a.aniimo-item-container")];

  const matches = cards
    .map(card => ({ card, pathScore: cardPathMatchScore(card, targetPath) }))
    .filter(match => match.pathScore > 0);
  const ordered = [...matches].sort((first, second) => {
    const firstMode = String(first.card.dataset.accountMode || "").toLowerCase();
    const secondMode = String(second.card.dataset.accountMode || "").toLowerCase();
    return second.pathScore - first.pathScore ||
      Number(secondMode === targetMode) - Number(firstMode === targetMode);
  });

  for (const { card } of ordered) {
    const source = imageSourceFromCard(card);
    if (source) return source;
  }

  return "";
}

function tradeCard(group, owner, info) {
  const card = document.createElement("article");
  card.className = "account-trade-card";

  const image = document.createElement("img");
  image.className = "account-trade-card-image";
  const variantSrc = variantImageSrc(group.path);
  const domImgSrc = findCardImageSrc(group.path, group.mode);
  const fallbackSrc = info?.imageUrl ? new URL(info.imageUrl, document.baseURI).href : "";
  // O HTML dos cards pode ainda não conter a imagem por causa do lazy loading.
  // O catálogo de variantes é a fonte determinística para formas como Trovoada.
  image.src = variantSrc || domImgSrc || fallbackSrc;
  image.alt = `${group.name} (${variantLabel(group, info)})`;

  const number = document.createElement("span");
  number.className = "account-trade-card-number";
  number.textContent = info?.entryId ? `NO.${String(info.entryId).padStart(3, "0")}` : "Aniimo";

  const name = document.createElement("strong");
  name.className = "account-trade-card-name";
  name.textContent = group.name;
  name.title = group.name;

  const variant = document.createElement("span");
  variant.className = "account-trade-card-variant";
  const modeText = group.mode === "umbrais" ? " • Umbrais" : "";
  variant.textContent = `${variantLabel(group, info)}${modeText}`;

  const label = document.createElement("span");
  label.className = "account-trade-card-label";
  label.textContent = `${owner}: ${group.count} cópias`;

  card.append(number, image, name, variant, label);
  return card;
}


async function openDuplicateComparison() {
  if (!currentUser || !viewingProfile || currentUser.id === viewingProfile.id) {
    showToast("Entre na sua conta e abra o perfil de outro usuário para comparar.", true);
    return;
  }
  try {
    await enableVariantsForProfile();
  } catch (error) {
    showToast(error.message || "Não foi possível preparar as variantes.", true);
    return;
  }
  try {
    await loadVariantImageCatalog();
  } catch (error) {
    // A comparação continua disponível com as imagens de reserva.
    console.warn("Não foi possível carregar o catálogo de imagens das variantes.", error);
  }
  const myOwnedSpecies = new Set(ownRows.map(speciesKey));
  const theirOwnedSpecies = new Set(viewingRows.map(speciesKey));
  // Uma troca só existe quando os dois lados oferecem um repetido exclusivo.
  const mine = [...duplicateGroups(ownRows).values()].filter(group => !theirOwnedSpecies.has(speciesKey(group)));
  const theirs = [...duplicateGroups(viewingRows).values()].filter(group => !myOwnedSpecies.has(speciesKey(group)));
  const pairs = [];
  for (const mineGroup of mine) {
    const mineInfo = tradeDetails(mineGroup);
    if (!mineInfo) continue;
    for (const theirGroup of theirs) {
      const theirInfo = tradeDetails(theirGroup);
      if (!theirInfo) continue;
      if (speciesKey(mineGroup) === speciesKey(theirGroup)) continue;
      const score = tradeScore(mineInfo, theirInfo);
      if (score > -Infinity) pairs.push({ mine: mineGroup, theirs: theirGroup, mineInfo, theirInfo, score });
    }
  }
  pairs.sort((a, b) =>
    b.score - a.score ||
    a.mine.name.localeCompare(b.mine.name, "pt-BR") ||
    a.theirs.name.localeCompare(b.theirs.name, "pt-BR") ||
    a.mine.key.localeCompare(b.mine.key) ||
    a.theirs.key.localeCompare(b.theirs.key)
  );
  const usedMine = new Set();
  const usedTheirs = new Set();
  const uniquePairs = [];
  for (const pair of pairs) {
    const mineSpecies = speciesKey(pair.mine);
    const theirSpecies = speciesKey(pair.theirs);
    if (usedMine.has(mineSpecies) || usedTheirs.has(theirSpecies)) continue;
    usedMine.add(mineSpecies);
    usedTheirs.add(theirSpecies);
    uniquePairs.push(pair);
  }
  const modal = modalShell(`
    <section class="account-modal account-comparison-modal" role="dialog" aria-modal="true" aria-labelledby="account-comparison-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">&times;</button>
      <h2 id="account-comparison-title">Sugestões de troca com @${viewingProfile.username}</h2>
      <p>Cada par troca dois repetidos exclusivos: você recebe um Aniimo que ainda não tem e a outra pessoa recebe um que ainda não possui. As sugestões nunca misturam Lumin, Gamma e Nova; região, elemento e função definem a prioridade.</p>
      <p class="account-modal-message" data-trade-message></p>
      <div class="account-trade-grid" data-trade-grid></div>
    </section>
  `);
  const grid = modal.querySelector("[data-trade-grid]");
  const message = modal.querySelector("[data-trade-message]");
  if (!catalogForTrades().size) {
    message.textContent = "O catálogo da wiki não foi carregado; atualize a página e tente novamente.";
    return;
  }
  if (!uniquePairs.length) {
    message.textContent = "Não há uma troca compatível entre os repetidos exclusivos de vocês.";
    return;
  }
  for (const pair of uniquePairs.slice(0, 30)) {
    const suggestion = document.createElement("article");
    suggestion.className = "account-trade-suggestion";
    suggestion.append(tradeCard(pair.mine, `@${ownProfile.username}`, pair.mineInfo));
    const arrow = document.createElement("div");
    arrow.className = "account-trade-arrow";
    arrow.textContent = "⇄";
    suggestion.append(arrow, tradeCard(pair.theirs, `@${viewingProfile.username}`, pair.theirInfo));
    grid.append(suggestion);
  }
}

async function waitForGrid() {
  const existing = document.querySelector(".aniimo-list-grid");
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error("A lista de Aniimos não foi carregada."));
    }, 20000);
    const observer = new MutationObserver(() => {
      const grid = document.querySelector(".aniimo-list-grid");
      if (grid) {
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve(grid);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function configureAniimoFilters() {
  const variants = document.querySelector(".aniimo-options-variants-all");
  const variantsFilter = variants?.closest(".wiki-container-content-filter-item");
  if (variantsFilter) variantsFilter.hidden = true;
  else if (variants) variants.hidden = true;

  const umbrals = document.querySelector(".aniimo-options-umbrals-show");
  if (!umbrals) return;
  const label = umbrals.querySelector(".aniimo-icon-text") || umbrals.querySelector("span:last-child");
  if (label) label.textContent = "Apenas Umbrais";
  else umbrals.textContent = "Apenas Umbrais";
  umbrals.setAttribute("aria-label", "Apenas Umbrais");
  umbrals.title = "Apenas Umbrais";
}

async function enableVariantsForProfile() {
  configureAniimoFilters();
  const button = document.querySelector(".aniimo-options-variants-all");
  const grid = await waitForGrid();
  if (!button) return;
  if (button.classList.contains("is-selected")) {
    cacheUmbralsCatalogPaths();
    return;
  }
  button.click();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const variantsSelected = button.classList.contains("is-selected");
    const cardCount = grid.querySelectorAll(":scope > a.aniimo-item-container").length;
    if (variantsSelected && cardCount > 130) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      cacheUmbralsCatalogPaths();
      return;
    }
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
  throw new Error("Não foi possível carregar as variantes para o perfil.");
}

async function loadPublicProfile() {
  if (!configured) {
    profileError = "Configure o Supabase para carregar perfis públicos.";
    mountProfilePanel();
    return;
  }
  try {
    const profile = await findProfileByUsername(profileHandle.trim());
    if (!profile) throw new Error("Este perfil não existe ou o nome de usuário está incorreto.");
    viewingProfile = profile;
    viewingRows = await loadCopies(profile.id);
    profileError = "";
    mountProfilePanel();
    renderGrid();
  } catch (error) {
    profileError = error.message;
    mountProfilePanel();
    showToast(error.message, true);
  }
}

async function addCopy(anchor) {
  if (!configured) {
    openConfigurationDialog();
    return;
  }
  if (!currentUser) {
    openAuthModal();
    return;
  }
  const { path, mode, name, key } = identityFor(anchor);
  try {
    await restRequest("aniimo_copies", {
      method: "POST",
      body: [{
        user_id: currentUser.id,
        aniimo_key: key,
        aniimo_path: path,
        display_name: name,
        background_mode: mode
      }],
      prefer: "return=minimal"
    });
    ownRows = await loadCopies(currentUser.id);
    if (profileMode && viewingProfile?.id === currentUser.id) viewingRows = ownRows;
    renderGrid();
    showToast(`${name} adicionado à coleção.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function removeCopy(anchor) {
  if (!currentUser) {
    openAuthModal();
    return;
  }
  const { path, mode, name } = identityFor(anchor);
  const copy = ownRows.find(row => row.aniimo_path === path && row.background_mode === mode);
  if (!copy) {
    showToast("Não foi possível encontrar uma cópia para remover.", true);
    return;
  }
  try {
    await restRequest(`aniimo_copies?id=eq.${encodeURIComponent(copy.id)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    ownRows = ownRows.filter(row => row.id !== copy.id);
    if (profileMode && viewingProfile?.id === currentUser.id) {
      viewingRows = viewingRows.filter(row => row.id !== copy.id);
    }
    renderGrid();
    showToast(`Uma cópia de ${name} foi removida.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindCardActions() {
  document.addEventListener("click", async event => {
    if (event.target.closest?.(".aniimo-options-umbrals-show")) {
      requestAnimationFrame(hideNonUmbralsFromUmbralsFilter);
    }
    const addButton = event.target.closest?.("[data-account-add]");
    if (addButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await addCopy(addButton.closest(".aniimo-item-container"));
      return;
    }
    const removeButton = event.target.closest?.("[data-account-remove]");
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await removeCopy(removeButton.closest(".aniimo-item-container"));
      return;
    }
    const copiesButton = event.target.closest?.("[data-account-copies]");
    if (copiesButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const card = copiesButton.closest(".aniimo-item-container");
      const { path, mode } = identityFor(card);
      openCopyManager(`${path}|${mode}`);
    }
  }, true);
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function chartPoint(index, value, radius = 96) {
  const angle = STAT_FIELDS[index].angle * Math.PI / 180;
  const distance = radius * value / 20;
  return [160 + Math.cos(angle) * distance, 160 + Math.sin(angle) * distance];
}

function drawChart(svg, values) {
  svg.replaceChildren();
  for (const amount of [5, 10, 15, 20]) {
    const points = STAT_FIELDS.map((_, index) => chartPoint(index, amount)).map(point => point.join(",")).join(" ");
    svg.append(svgElement("polygon", { points, class: "stat-ring" }));
  }
  STAT_FIELDS.forEach((stat, index) => {
    const end = chartPoint(index, 20);
    svg.append(svgElement("line", { x1: 160, y1: 160, x2: end[0], y2: end[1], class: "stat-axis" }));
  });
  const points = STAT_FIELDS.map((stat, index) => chartPoint(index, values[stat.key])).map(point => point.join(",")).join(" ");
  svg.append(svgElement("polygon", { points, class: "stat-polygon" }));
  STAT_FIELDS.forEach((stat, index) => {
    const [x, y] = chartPoint(index, values[stat.key]);
    const [labelX, labelY] = chartPoint(index, 29);
    svg.append(svgElement("circle", { cx: x, cy: y, r: 12, class: "stat-marker" }));
    const value = svgElement("text", { x, y });
    value.textContent = String(values[stat.key]);
    svg.append(value);
    const label = svgElement("text", { x: labelX, y: labelY });
    label.textContent = stat.label;
    svg.append(label);
  });
}

function openCopyManager(key) {
  const rows = (profileMode ? viewingRows : ownRows).filter(row => row.aniimo_key === key);
  if (!rows.length) return;
  const editable = Boolean(currentUser && viewingProfile?.id === currentUser.id) || !profileMode;
  const modal = modalShell(`
    <section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-stats-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">×</button>
      <h2 id="account-stats-title">Status inatos</h2>
      <p data-copy-name></p>
      <div class="account-copy-list" data-copy-list></div>
      <svg class="account-stat-chart" data-stat-chart viewBox="0 0 320 320" role="img" aria-label="Gráfico hexagonal dos status inatos"></svg>
      <div class="account-stat-controls" data-stat-controls></div>
      <p class="account-modal-message" aria-live="polite"></p>
      <div class="account-modal-actions">
        <button type="button" data-save-stats>Salvar status</button>
        <button type="button" class="account-danger" data-delete-copy>Remover esta cópia</button>
      </div>
    </section>
  `);
  const chart = modal.querySelector("[data-stat-chart]");
  const list = modal.querySelector("[data-copy-list]");
  const controls = modal.querySelector("[data-stat-controls]");
  const name = modal.querySelector("[data-copy-name]");
  const saveButton = modal.querySelector("[data-save-stats]");
  const deleteButton = modal.querySelector("[data-delete-copy]");
  if (!editable) {
    saveButton.hidden = true;
    deleteButton.hidden = true;
    modal.querySelector("[data-stat-controls]").classList.add("is-readonly");
  }
  let selected = rows[0];
  let values = readStats(selected);
  let dragIndex = -1;
  name.textContent = selected.display_name;

  function readStats(row) {
    return Object.fromEntries(STAT_FIELDS.map(stat => [
      stat.key,
      Math.max(0, Math.min(20, Number(row[stat.key]) || 0))
    ]));
  }

  function updateControls() {
    for (const stat of STAT_FIELDS) {
      const input = controls.querySelector(`[data-stat-input="${stat.key}"]`);
      const output = controls.querySelector(`[data-stat-value="${stat.key}"]`);
      input.value = String(values[stat.key]);
      output.textContent = String(values[stat.key]);
    }
    drawChart(chart, values);
  }

  function selectCopy(row) {
    selected = row;
    values = readStats(row);
    name.textContent = row.display_name;
    for (const button of list.querySelectorAll("button")) {
      button.classList.toggle("is-active", button.dataset.copyId === row.id);
      button.setAttribute("aria-pressed", String(button.dataset.copyId === row.id));
    }
    updateControls();
  }

  rows.forEach((row, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.copyId = row.id;
    button.textContent = `Cópia ${index + 1}`;
    button.addEventListener("click", () => selectCopy(row));
    list.append(button);
  });
  for (const stat of STAT_FIELDS) {
    const label = document.createElement("label");
    label.className = "account-stat-control";
    const title = document.createElement("span");
    title.textContent = `${stat.label}: `;
    const output = document.createElement("output");
    output.dataset.statValue = stat.key;
    title.append(output);
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "20";
    input.step = "1";
    input.dataset.statInput = stat.key;
    input.disabled = !editable;
    input.addEventListener("input", () => {
      values[stat.key] = Number(input.value);
      updateControls();
    });
    label.append(title, input);
    controls.append(label);
  }
  if (!editable) controls.querySelectorAll("input").forEach(input => { input.disabled = true; });
  selectCopy(selected);

  function updateFromPointer(event) {
    const rect = chart.getBoundingClientRect();
    const x = (event.clientX - rect.left) * 320 / rect.width;
    const y = (event.clientY - rect.top) * 320 / rect.height;
    const dx = x - 160;
    const dy = y - 160;
    const angle = Math.atan2(dy, dx);
    dragIndex = STAT_FIELDS.reduce((nearest, stat, index) => {
      const targetAngle = stat.angle * Math.PI / 180;
      const difference = Math.abs(Math.atan2(Math.sin(angle - targetAngle), Math.cos(angle - targetAngle)));
      return difference < nearest.difference ? { index, difference } : nearest;
    }, { index: 0, difference: Infinity }).index;
    values[STAT_FIELDS[dragIndex].key] = Math.round(Math.max(0, Math.min(96, Math.hypot(dx, dy))) / 96 * 20);
    updateControls();
  }

  chart.addEventListener("pointerdown", event => {
    if (!editable) return;
    event.preventDefault();
    chart.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  chart.addEventListener("pointermove", event => {
    if (editable && chart.hasPointerCapture(event.pointerId)) updateFromPointer(event);
  });
  chart.addEventListener("pointerup", event => {
    if (chart.hasPointerCapture(event.pointerId)) chart.releasePointerCapture(event.pointerId);
    dragIndex = -1;
  });

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      const result = await restRequest(`aniimo_copies?id=eq.${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        body: values,
        prefer: "return=minimal"
      });
      selected = { ...selected, ...values };
      const collections = profileMode ? viewingRows : ownRows;
      const index = collections.findIndex(row => row.id === selected.id);
      if (index >= 0) collections[index] = selected;
      modalMessage(modal, "Status salvos.", true);
      showToast("Status inatos atualizados.");
    } catch (error) {
      modalMessage(modal, error.message);
    } finally {
      saveButton.disabled = false;
    }
  });

  deleteButton.addEventListener("click", async () => {
    if (!window.confirm("Remover esta cópia da coleção?")) return;
    deleteButton.disabled = true;
    try {
      await restRequest(`aniimo_copies?id=eq.${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
      ownRows = ownRows.filter(row => row.id !== selected.id);
      viewingRows = viewingRows.filter(row => row.id !== selected.id);
      closeModal(modal);
      renderGrid();
      showToast("Cópia removida da coleção.");
    } catch (error) {
      modalMessage(modal, error.message);
      deleteButton.disabled = false;
    }
  });
}

async function restoreSession() {
  if (!session || !configured) return;
  try {
    await loadSignedInState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function initialize() {
  renderToolbar();
  bindCardActions();
  startGridObserver();
  try {
    await waitForGrid();
    const query = new URLSearchParams(location.search);
    observeGrid(document.querySelector(".aniimo-list-grid"));
    await enableVariantsForProfile();
    renderGrid();
    if (session && configured) await restoreSession();
    if (query.has("profile")) await activateProfileRoute(query.get("profile") || "");
  } catch (error) {
    showToast(error.message, true);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY) return;
  session = readSession();
  if (!session) {
    clearSession();
    return;
  }
  restoreSession();
});

window.addEventListener("popstate", () => {
  const query = new URLSearchParams(location.search);
  if (query.has("profile")) {
    activateProfileRoute(query.get("profile") || "");
    return;
  }
  profileMode = false;
  profileHandle = "";
  viewingProfile = null;
  viewingRows = [];
  profilePanel?.remove();
  profilePanel = null;
  onlyOwned = false;
  onlyDuplicates = false;
  renderGrid();
});

