# Ateliê Web

CRM pessoal para propostas de programação: clientes, plataformas (Workana etc.), propostas com anexos e histórico, e orçamentos formais numerados prontos para imprimir em PDF.

## Como usar

Abra o site pelo GitHub Pages: `https://jmarcicofast-cell.github.io/atelieweb/`

- Entre com o login do Ateliê Web (Meus dados → Nuvem). Com o login feito, clientes, propostas, orçamentos, projetos e anexos (até 15 MB cada) ficam salvos no Firebase (`crm/dados/...`) e aparecem em qualquer navegador onde você entrar. Sem login, os dados ficam só no navegador (IndexedDB) e sobem para a nuvem no próximo login.
- As regras de `firestore.rules` precisam estar publicadas no console do Firebase (Firestore → Regras) para a nuvem funcionar.
- Em **Meus dados → Backup**, dá para exportar uma cópia extra em `.json`.
- Orçamentos: abra o orçamento e clique em **Imprimir / PDF** → destino "Salvar como PDF".

## Arquivos

- `index.html` — o site inteiro (HTML, CSS e JavaScript em um arquivo só).
