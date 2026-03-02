import React, { useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { SignalCellularAlt, Mic, MicOff, CallEnd } from '@mui/icons-material';

// Déplacer simplement l'overlay existant
const CallControlsOverlay = () => {
  const [isMuted, setIsMuted] = useState(false);

  return (
    <Box
      sx={{
        position: 'fixed',
        left: 16,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        zIndex: 1000
      }}
    >
      <Tooltip title="Connection status" placement="right">
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            backgroundColor: '#4CAF50',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 3
          }}
        >
          <SignalCellularAlt sx={{ color: 'white' }} />
        </Box>
      </Tooltip>

      <Tooltip title={isMuted ? 'Unmute' : 'Mute'} placement="right">
        <IconButton
          onClick={() => setIsMuted(!isMuted)}
          sx={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            backgroundColor: isMuted ? '#F44336' : '#2196F3',
            color: 'white',
            boxShadow: 3,
            '&:hover': {
              backgroundColor: isMuted ? '#D32F2F' : '#1976D2'
            }
          }}
        >
          {isMuted ? <MicOff /> : <Mic />}
        </IconButton>
      </Tooltip>

      <Tooltip title="End call" placement="right">
        <IconButton
          sx={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            backgroundColor: '#F44336',
            color: 'white',
            boxShadow: 3,
            '&:hover': {
              backgroundColor: '#D32F2F'
            }
          }}
        >
          <CallEnd />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default CallControlsOverlay;