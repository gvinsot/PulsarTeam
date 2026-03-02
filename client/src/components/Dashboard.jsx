import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import AgentListItem from './AgentListItem';

const Dashboard = ({ agents }) => {
  const [sortedAgents, setSortedAgents] = useState([]);

  useEffect(() => {
    // Sort agents with 'swarm manager' role first
    const sorted = [...agents].sort((a, b) => {
      if (a.role === 'swarm manager' && b.role !== 'swarm manager') return -1;
      if (a.role !== 'swarm manager' && b.role === 'swarm manager') return 1;
      return 0;
    });
    setSortedAgents(sorted);
  }, [agents]);

  return (
    <div className="dashboard">
      <h1>Agent Dashboard</h1>
      <div className="agent-list">
        {/* Agent list */}
        {sortedAgents.map(agent => (
          <AgentListItem key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
};

Dashboard.propTypes = {
  agents: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      role: PropTypes.string.isRequired,
    })
  ).isRequired,
};

export default Dashboard;