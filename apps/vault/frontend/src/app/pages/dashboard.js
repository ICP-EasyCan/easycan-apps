/**
 * dashboard.js — Dashboard and overview page
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate } from '@shared/ui/router.js';
import { countEncryptedRecords } from '../../lib/encrypted-crud.js';

export async function renderDashboard(container) {
  // Render structure immediately
  render(container,
    el('div', { class: 'page-vault page-dashboard' },
      el('div', { class: 'dashboard-header' },
        el('h2', { class: 'dashboard-title' }, 'Your Vault'),
        el('p', { class: 'dashboard-subtitle' }, 'Security Overview')
      ),
      el('div', { class: 'dashboard-cards', id: 'dashboard-cards' },
        // Placeholder loading cards
        createLoadingCard('\u{1F512}', 'Passwords'),
        createLoadingCard('\u{1F4C1}', 'Encrypted Files'),
        createLoadingCard('\u{1F4DD}', 'Secret Notes')
      )
    )
  );

  // Fetch actual counts
  try {
    const [passwordsCount, filesCount, notesCount] = await Promise.all([
      countEncryptedRecords('passwords'),
      countEncryptedRecords('files'),
      countEncryptedRecords('notes')
    ]);

    const cardsContainer = document.getElementById('dashboard-cards');
    if (!cardsContainer) return;

    render(cardsContainer,
      createDashboardCard({
        title: 'Passwords',
        count: passwordsCount,
        icon: '\u{1F512}',
        route: '#passwords',
        actionRoute: '#password/new',
        actionLabel: '+ New'
      }),
      createDashboardCard({
        title: 'Encrypted Files',
        count: filesCount,
        icon: '\u{1F4C1}',
        route: '#files',
        // For files we just go to the list which has a triggerUpload
        actionRoute: '#files',
        actionLabel: 'Manage'
      }),
      createDashboardCard({
        title: 'Secret Notes',
        count: notesCount,
        icon: '\u{1F4DD}',
        route: '#notes',
        actionRoute: '#note/new',
        actionLabel: '+ Create'
      })
    );
  } catch (err) {
    console.error('Failed to load dashboard counts', err);
    // Silent fail on counts, user can still click cards
  }
}

function createLoadingCard(icon, title) {
  return el('div', { class: 'dashboard-card loading' },
    el('div', { class: 'dashboard-card-icon' }, icon),
    el('div', { class: 'dashboard-card-info' },
      el('h3', {}, title),
      el('p', {}, 'Calculating...')
    )
  );
}

function createDashboardCard({ title, count, icon, route, actionRoute, actionLabel }) {
  return el('div', { class: 'dashboard-card', onClick: () => navigate(route) },
    el('div', { class: 'dashboard-card-header' },
      el('div', { class: 'dashboard-card-icon' }, icon),
      el('div', { class: 'dashboard-card-info' },
        el('h3', {}, title),
        el('p', { class: 'dashboard-card-count' }, `${count} item${count === 1 ? '' : 's'}`)
      )
    ),
    el('div', { class: 'dashboard-card-action' },
      el('button', { 
        class: 'btn-secondary small', 
        onClick: (e) => {
          e.stopPropagation(); // Prevent card click
          navigate(actionRoute);
        }
      }, actionLabel)
    )
  );
}
