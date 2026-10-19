const $ = (id) => document.getElementById(id);
let showingConnectionError = false;
let cleanupView = '';
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response.error) throw new Error(response.error);
  return response.result;
}
function error(error) {
  showingConnectionError = false;
  $('error').hidden = false;
  $('error').textContent = error.message;
}
async function refresh() {
  const state = await request({ type: 'state' });
  $('auto-archive').checked = state.settings.autoArchive === true;
  const view = JSON.stringify([state.ownedTabs, state.archives]);
  if (view !== cleanupView) {
    cleanupView = view;
    $('owned-tabs').replaceChildren();
    for (const tab of state.ownedTabs || []) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!tab.keep;
      checkbox.onchange = () =>
        request({ type: 'keep-tab', tabID: tab.id, keep: checkbox.checked })
          .then(refresh)
          .catch(error);
      label.append(checkbox, document.createTextNode(`Keep: ${tab.title || tab.url || tab.id}`));
      $('owned-tabs').append(label);
      const indicatorButton = document.createElement('button');
      indicatorButton.textContent = tab.indicatorHidden
        ? 'Show page activity dot'
        : 'Hide page activity dot';
      indicatorButton.onclick = () =>
        request({ type: 'indicator-visibility', tabID: tab.id, hidden: !tab.indicatorHidden })
          .then(refresh)
          .catch(error);
      $('owned-tabs').append(indicatorButton);
    }
    $('archives').replaceChildren();
    for (const archive of state.archives || []) {
      const button = document.createElement('button');
      button.textContent = `Restore: ${archive.title || archive.url}`;
      button.onclick = async () => {
        button.disabled = true;
        try {
          await request({ type: 'restore-archive', id: archive.id });
          await refresh();
        } catch (e) {
          error(e);
          button.disabled = false;
        }
      };
      $('archives').append(button);
      const forget = document.createElement('button');
      forget.textContent = 'Delete saved URL';
      forget.onclick = () =>
        request({ type: 'forget-archive', id: archive.id }).then(refresh).catch(error);
      $('archives').append(forget);
    }
  }
  $('cleanup-status').textContent = state.cleanupError || '';
  $('status').textContent = !state.ready
    ? '○ Bridge disconnected'
    : state.enabled
      ? '● Ready — sessions can open tabs'
      : '○ Browser access disabled';
  if (state.connectionError) {
    error(new Error(state.connectionError));
    showingConnectionError = true;
  } else if (showingConnectionError) {
    $('error').hidden = true;
    showingConnectionError = false;
  }
}
$('auto-archive').onchange = async () => {
  try {
    await request({ type: 'cleanup-settings', autoArchive: $('auto-archive').checked });
    await refresh();
  } catch (e) {
    error(e);
  }
};
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  $('error').hidden = true;
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted)
      throw new Error('Website permission is needed for browser tools and screenshots.');
    await request({
      type: 'settings',
      url: $('url').value,
      token: $('token').value.trim(),
      profileName: $('profile-name').value.trim(),
    });
    await refresh();
  } catch (e) {
    error(e);
  }
};
$('disable').onclick = async () => {
  try {
    await request({ type: 'disable' });
    await refresh();
  } catch (e) {
    error(e);
  }
};
try {
  const state = await request({ type: 'state' });
  $('url').value = state.settings.url || 'http://127.0.0.1:8790';
  $('token').value = state.settings.token || '';
  $('profile-name').value = state.settings.profileName || 'Chrome profile';
  $('profile-id').textContent = state.settings.profileID || 'Available after pairing';
  await refresh();
} catch (e) {
  error(e);
}
setInterval(() => {
  void refresh().catch(error);
}, 1000);
