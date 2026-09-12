import React from 'react';
import Settings from './Settings';

export default function UnifiedSettings() {
  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
      `}</style>
      <Settings />
    </div>
  );
}
