import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  TextField,
  Button,
} from '@mui/material';

interface NameDialogProps {
  open: boolean;
  onSubmit: (name: string) => void;
}

export function NameDialog({ open, onSubmit }: NameDialogProps) {
  const [name, setName] = useState('');

  useEffect(() => {
    const savedName = localStorage.getItem('userName');
    if (savedName) {
      setName(savedName);
    }
  }, []);

  const handleSubmit = () => {
    if (name.trim()) {
      localStorage.setItem('userName', name.trim());
      onSubmit(name.trim());
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <Dialog
      open={open}
      PaperProps={{
        sx: {
          backgroundColor: '#28292c',
          borderRadius: '8px',
          minWidth: '400px',
        },
      }}
    >
      <DialogTitle sx={{ color: '#e8eaed', pb: 1 }}>
        Представьтесь
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <TextField
          autoFocus
          fullWidth
          placeholder="Введите ваше имя"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyPress={handleKeyPress}
          variant="outlined"
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              backgroundColor: '#3c4043',
              color: '#e8eaed',
              borderRadius: '4px',
              '& fieldset': {
                borderColor: '#5f6368',
              },
              '&:hover fieldset': {
                borderColor: '#8ab4f8',
              },
              '&.Mui-focused fieldset': {
                borderColor: '#8ab4f8',
              },
            },
            '& .MuiInputBase-input': {
              padding: '12px 14px',
            },
            '& .MuiInputBase-input::placeholder': {
              color: '#9aa0a6',
              opacity: 1,
            },
          }}
        />
        <Button
          fullWidth
          variant="contained"
          onClick={handleSubmit}
          disabled={!name.trim()}
          sx={{
            backgroundColor: '#8ab4f8',
            color: '#202124',
            textTransform: 'none',
            fontSize: '0.875rem',
            padding: '10px 24px',
            borderRadius: '4px',
            '&:hover': {
              backgroundColor: '#a8c7fa',
            },
            '&.Mui-disabled': {
              backgroundColor: '#5f6368',
              color: '#9aa0a6',
            },
          }}
        >
          Войти
        </Button>
      </DialogContent>
    </Dialog>
  );
}
