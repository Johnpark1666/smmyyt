import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { useNavigate } from 'react-router-dom';

function AuthCallback() {
  const [status, setStatus] = useState<string>('Processing...');
  const navigate = useNavigate();

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      api.post('/auth/callback', { code })
        .then(() => {
          setStatus('Success! Redirecting...');
          setTimeout(() => navigate('/'), 2000);
        })
        .catch((err: Error) => setStatus(`Error: ${err.message}`));
    } else {
      setStatus('No code found.');
    }
  }, [navigate]);

  return (
    <div className="p-8 text-center">
      <h2 className="text-xl font-bold">{status}</h2>
    </div>
  );
}

export default AuthCallback;