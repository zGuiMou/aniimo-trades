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
  if (!session?.refresh_token) throw new Error("Sua sessÃ£o expirou. Entre novamente.");
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
  const params = new URLSearchParams({ select: "id,username", [field]: `eq.${value}`, limit: "1" });
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
    select: "id,username,created_at",
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
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">Ã—</button>
      <h2 id="account-setup-title">Configure as contas</h2>
      <p>Adicione a Project URL e a chave pÃºblica do Supabase em <code>supabase-config.js</code> e execute <code>supabase-schema.sql</code> no SQL Editor do projeto.</p>
      <p>Use somente a chave pÃºblica anon/publishable â€” nunca a chave <code>service_role</code>.</p>
      <p data-account-config-warning></p>
      <p><a href="SUPABASE_SETUP.md" target="_blank" rel="noopener">Ver instruÃ§Ãµes completas</a></p>
    </section>
  `);
  if (secretKeySupplied) {
    modal.querySelector("[data-account-config-warning]").textContent =
      "A chave configurada parece ser secreta e nÃ£o serÃ¡ usada. Remova-a do arquivo e use a chave pÃºblica.";
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
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">Ã—</button>
      <h2 id="account-auth-title">Entrar na coleÃ§Ã£o</h2>
      <form class="account-form" novalidate>
        <label data-signup-field>Nome de usuÃ¡rio
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
    title.textContent = signup ? "Criar conta" : "Entrar na coleÃ§Ã£o";
    modal.querySelector("[data-signup-field]").hidden = !signup;
    username.required = signup;
    password.autocomplete = signup ? "new-password" : "current-password";
    submit.textContent = signup ? "Criar conta" : "Entrar";
    toggle.textContent = signup ? "JÃ¡ tenho conta" : "Criar conta";
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
      modalMessage(modal, "Use de 3 a 24 letras, nÃºmeros ou _ no nome de usuÃ¡rio.");
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
    throw new Error("O Supabase nÃ£o retornou uma sessÃ£o vÃ¡lida.");
  }
  saveSession(value);
  await loadSignedInState();
}

async function loadSignedInState() {
  const user = await authUser();
  const profile = await findProfileById(user.id);
  if (!profile) throw new Error("Perfil nÃ£o encontrado. Verifique a configuraÃ§Ã£o do trigger no Supabase.");
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
    showToast("VocÃª saiu da conta.");
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
    profileError = "Configure o Supabase para carregar perfis pÃºblicos.";
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

function isUmbralsFilterActive() {
  return Boolean(document.querySelector(".aniimo-options-umbrals-show.is-selected"));
}

function canonicalPath(anchor) {
  const target = new URL(anchor.getAttribute("href") || "", location.href);
  return target.pathname
    .replace(new RegExp(`^/(${LOCALES})(?=/)`), "")
    .replace(/\/+$/, "") || "/";
}

function backgroundMode(anchor) {
  if (profileMode && anchor.dataset.accountMode) return anchor.dataset.accountMode;
  return isUmbralsFilterActive() ? "umbrais" : "normal";
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
  anchor.querySelectorAll(".account-add-button, .account-count-badge").forEach(node => node.remove());
  delete anchor.dataset.accountUiAdd;
  delete anchor.dataset.accountUiCount;
}

function addCardControls(anchor, path, mode, copies, allowAdd) {
  clearCardControls(anchor);
  anchor.dataset.accountPath = path;
  anchor.dataset.accountMode = mode;
  anchor.dataset.accountUiAdd = String(allowAdd);
  anchor.dataset.accountUiCount = String(copies.length > 0);
  if (allowAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "account-add-button";
    add.dataset.accountAdd = "true";
    add.setAttribute("aria-label", `Adicionar ${identityFor(anchor, mode).name} Ã  coleÃ§Ã£o`);
    add.textContent = "+";
    anchor.append(add);
  }
  if (copies.length) {
    const count = document.createElement("button");
    count.type = "button";
    count.className = "account-count-badge";
    count.dataset.accountCopies = "true";
    count.textContent = `${copies.length}Ã—`;
    count.setAttribute("aria-label", `${copies.length} cÃ³pias. Gerenciar status inatos`);
    anchor.append(count);
  }
}

function rowsFor(path, mode, rows) {
  return rows.filter(row => row.aniimo_path === path && row.background_mode === mode);
}

function renderGrid() {
  if (!observedGrid) return;
  const grid = observedGrid;
  if (profileMode) mountProfilePanel();
  grid.querySelectorAll(":scope > [data-account-profile-clone]").forEach(node => node.remove());
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
    return;
  }
  for (const card of cards) {
    card.hidden = false;
    card.classList.remove("account-not-owned");
    const path = canonicalPath(card);
    const mode = isUmbralsFilterActive() ? "umbrais" : "normal";
    addCardControls(card, path, mode, rowsFor(path, mode, ownRows), true);
  }
}

function renderProfileCards(grid, cards) {
  const canEdit = currentUser?.id === viewingProfile.id;
  for (const card of cards) {
    const path = canonicalPath(card);
    const copies = viewingRows.filter(row => row.aniimo_path === path);
    const modes = [...new Set(copies.map(row => row.background_mode))];
    if (!modes.length) modes.push(isUmbralsFilterActive() ? "umbrais" : "normal");
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

function mountProfilePanel() {
  if (!profileMode || !observedGrid) return;
  if (!profilePanel || !profilePanel.isConnected) {
    profilePanel = document.createElement("section");
    profilePanel.className = "account-profile-panel";
    profilePanel.innerHTML = `
      <h2 data-profile-title>Perfil pÃºblico</h2>
      <p data-profile-status aria-live="polite"></p>
      <label><input type="checkbox" data-only-owned> Mostrar apenas os Aniimos que tenho</label>
      <label><input type="checkbox" data-only-duplicates> Mostrar apenas repetidos</label>
      <button type="button" data-compare-duplicates hidden>Comparar repetidos</button>
      <button type="button" data-share-profile>Copiar link pÃºblico</button>
      <button type="button" data-home>Voltar Ã  pÃ¡gina inicial</button>
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
        showToast("Link pÃºblico copiado.");
      } catch {
        showToast("NÃ£o foi possÃ­vel copiar automaticamente. Copie o endereÃ§o do navegador.", true);
      }
    });
  }
  const title = profilePanel.querySelector("[data-profile-title]");
  const status = profilePanel.querySelector("[data-profile-status]");
  const titleText = viewingProfile ? `ColeÃ§Ã£o de @${viewingProfile.username}` : "Perfil pÃºblico";
  const statusText = profileError || (viewingProfile
    ? `${viewingRows.length} Aniimos na coleÃ§Ã£o${currentUser?.id === viewingProfile.id ? " â€” este Ã© o seu perfil" : ""}.`
    : "Carregando perfil pÃºblicoâ€¦");
  if (title.textContent !== titleText) title.textContent = titleText;
  status.classList.toggle("account-profile-error", Boolean(profileError));
  if (status.textContent !== statusText) status.textContent = statusText;
  const compare = profilePanel.querySelector("[data-compare-duplicates]");
  compare.hidden = !currentUser || !viewingProfile || currentUser.id === viewingProfile.id;
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

function catalogForTrades() {
  if (tradeCatalog) return tradeCatalog;
  tradeCatalog = new Map();
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
        tradeCatalog.set(String(value.entryId).padStart(3, "0"), value);
      }
      Object.values(value).forEach(child => walk(child, visited));
    };
    walk(revive(0));
  } catch (error) {
    console.warn("NÃ£o foi possÃ­vel ler o catÃ¡logo para as sugestÃµes de troca.", error);
  }
  return tradeCatalog;
}

function tradeDetails(group) {
  const match = group.path.match(/\/item\/(\d+)/);
  return match ? catalogForTrades().get(match[1].padStart(3, "0")) || null : null;
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

function tradeCard(group, owner) {
  const source = [...document.querySelectorAll(".aniimo-list-grid > a.aniimo-item-container")]
    .find(card => (card.dataset.accountPath || canonicalPath(card)) === group.path &&
      (card.dataset.accountMode || backgroundMode(card)) === group.mode);
  const card = source ? source.cloneNode(true) : document.createElement("div");
  if (!source) {
    card.className = "aniimo-item-container account-trade-card-fallback";
    card.innerHTML = `<div class="aniimo-item-top-image"></div><div class="text-center"><span></span></div>`;
    card.querySelector("span").textContent = group.name;
  }
  card.classList.add("account-trade-card");
  clearCardControls(card);
  card.removeAttribute("data-account-profile-clone");
  setCardBackground(card, group.mode);
  const label = document.createElement("span");
  label.className = "account-trade-card-label";
  label.textContent = `${owner}: ${group.count} cÃ³pias`;
  card.append(label);
  return card;
}

function openDuplicateComparison() {
  if (!currentUser || !viewingProfile || currentUser.id === viewingProfile.id) {
    showToast("Entre na sua conta e abra o perfil de outro usuÃ¡rio para comparar.", true);
    return;
  }
  const myOwnedKeys = new Set(ownRows.map(row => `${row.aniimo_path}|${row.background_mode}`));
  const theirOwnedKeys = new Set(viewingRows.map(row => `${row.aniimo_path}|${row.background_mode}`));
  // Uma troca sÃ³ existe quando os dois lados oferecem um repetido exclusivo.
  const mine = [...duplicateGroups(ownRows).values()].filter(group => !theirOwnedKeys.has(group.key));
  const theirs = [...duplicateGroups(viewingRows).values()].filter(group => !myOwnedKeys.has(group.key));
  const pairs = [];
  for (const mineGroup of mine) {
    const mineInfo = tradeDetails(mineGroup);
    if (!mineInfo) continue;
    for (const theirGroup of theirs) {
      const theirInfo = tradeDetails(theirGroup);
      if (!theirInfo) continue;
      const score = tradeScore(mineInfo, theirInfo);
      if (score > -Infinity) pairs.push({ mine: mineGroup, theirs: theirGroup, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.mine.name.localeCompare(b.mine.name, "pt-BR"));
  const modal = modalShell(`
    <section class="account-modal account-comparison-modal" role="dialog" aria-modal="true" aria-labelledby="account-comparison-title">
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">&times;</button>
      <h2 id="account-comparison-title">SugestÃµes de troca com @${viewingProfile.username}</h2>
      <p>Cada par troca dois repetidos exclusivos: vocÃª recebe um Aniimo que ainda nÃ£o tem e a outra pessoa recebe um que ainda nÃ£o possui. As sugestÃµes nunca misturam Lumin, Gamma e Nova; regiÃ£o, elemento e funÃ§Ã£o definem a prioridade.</p>
      <p class="account-modal-message" data-trade-message></p>
      <div class="account-trade-grid" data-trade-grid></div>
    </section>
  `);
  const grid = modal.querySelector("[data-trade-grid]");
  const message = modal.querySelector("[data-trade-message]");
  if (!catalogForTrades().size) {
    message.textContent = "O catÃ¡logo da wiki nÃ£o foi carregado; atualize a pÃ¡gina e tente novamente.";
    return;
  }
  if (!pairs.length) {
    message.textContent = "NÃ£o hÃ¡ uma troca compatÃ­vel entre os repetidos exclusivos de vocÃªs.";
    return;
  }
  for (const pair of pairs.slice(0, 30)) {
    const suggestion = document.createElement("article");
    suggestion.className = "account-trade-suggestion";
    suggestion.append(tradeCard(pair.mine, `@${ownProfile.username}`));
    const arrow = document.createElement("div");
    arrow.className = "account-trade-arrow";
    arrow.textContent = "â‡„";
    suggestion.append(arrow, tradeCard(pair.theirs, `@${viewingProfile.username}`));
    grid.append(suggestion);
  }
}

async function waitForGrid() {
  const existing = document.querySelector(".aniimo-list-grid");
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error("A lista de Aniimos nÃ£o foi carregada."));
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

async function enableVariantsForProfile() {
  const button = document.querySelector(".aniimo-options-variants-all");
  if (!button || button.classList.contains("is-selected")) return;
  button.click();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (document.querySelectorAll(".aniimo-list-grid > a").length > 130) return;
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
  throw new Error("NÃ£o foi possÃ­vel carregar as variantes para o perfil.");
}

async function loadPublicProfile() {
  if (!configured) {
    profileError = "Configure o Supabase para carregar perfis pÃºblicos.";
    mountProfilePanel();
    return;
  }
  try {
    const profile = await findProfileByUsername(profileHandle.trim());
    if (!profile) throw new Error("Este perfil nÃ£o existe ou o nome de usuÃ¡rio estÃ¡ incorreto.");
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
    showToast(`${name} adicionado Ã  coleÃ§Ã£o.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindCardActions() {
  document.addEventListener("click", async event => {
    const addButton = event.target.closest?.("[data-account-add]");
    if (addButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await addCopy(addButton.closest(".aniimo-item-container"));
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
      <button class="account-modal-close" type="button" data-account-close aria-label="Fechar">Ã—</button>
      <h2 id="account-stats-title">Status inatos</h2>
      <p data-copy-name></p>
      <div class="account-copy-list" data-copy-list></div>
      <svg class="account-stat-chart" data-stat-chart viewBox="0 0 320 320" role="img" aria-label="GrÃ¡fico hexagonal dos status inatos"></svg>
      <div class="account-stat-controls" data-stat-controls></div>
      <p class="account-modal-message" aria-live="polite"></p>
      <div class="account-modal-actions">
        <button type="button" data-save-stats>Salvar status</button>
        <button type="button" class="account-danger" data-delete-copy>Remover esta cÃ³pia</button>
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
    button.textContent = `CÃ³pia ${index + 1}`;
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
    if (!window.confirm("Remover esta cÃ³pia da coleÃ§Ã£o?")) return;
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
      showToast("CÃ³pia removida da coleÃ§Ã£o.");
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

