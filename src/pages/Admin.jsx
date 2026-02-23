import Layout from '../components/Layout';
import './Dashboard.css';

export default function Admin() {
  return (
    <Layout title="Admin" subtitle="PBX Call Centre — Team & queue management">
      <div className="dashboard">
        <section className="dashboard-section">
          <h2>Team & queues</h2>
          <div className="card-grid">
            <div className="stat-card">
              <span className="stat-value">8</span>
              <span className="stat-label">Online agents</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">3</span>
              <span className="stat-label">Queues</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">24</span>
              <span className="stat-label">Waiting</span>
            </div>
          </div>
        </section>
        <section className="dashboard-section">
          <h2>Management</h2>
          <div className="action-list">
            <button type="button" className="action-btn">Agent roster</button>
            <button type="button" className="action-btn">Queue config</button>
            <button type="button" className="action-btn">Reports</button>
          </div>
        </section>
      </div>
    </Layout>
  );
}
