import './style.css';
import { loadDashboard } from './data/mock';
import { renderDashboard } from './render';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

loadDashboard().then((data) => {
  renderDashboard(root, data, new Date());
});
