import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { useBranding } from '../context/BrandingContext';
import './Dashboard.css';

export default function User() {
  const navigate = useNavigate();
  const { branding } = useBranding();

  return (
    <Layout title="User" subtitle={`${branding.productName} — Supervisor / Team lead`}>
      <div className="dashboard">
        <section className="dashboard-section">
          <h2>Overview</h2>
          <div className="card-grid">
            <div className="stat-card">
              <span className="stat-value">—</span>
              <span className="stat-label">My activity</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">—</span>
              <span className="stat-label">Reports access</span>
            </div>
          </div>
        </section>
        <section className="dashboard-section">
          <h2>Options</h2>
          <div className="action-list">
            <button
              type="button"
              className="action-btn"
              onClick={() => navigate('/wallboard')}
            >
              Live wallboard
            </button>
            <button type="button" className="action-btn">View reports</button>
            <button type="button" className="action-btn">Contact list</button>
          </div>
        </section>
      </div>
    </Layout>
  );
}
