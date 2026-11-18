# Configuração de contas e coleções

O site continua estático; o Supabase fornece autenticação e armazenamento compartilhado.

1. Crie um projeto no Supabase.
2. No SQL Editor do projeto, execute [`supabase-schema.sql`](./supabase-schema.sql).
3. Copie a Project URL e a chave pública (anon/publishable) para `supabase-config.js`.
   Não use nem publique a chave `service_role`.
4. Em **Authentication → URL Configuration**, configure o domínio do site como Site URL e adicione também os endereços de redirecionamento usados no desenvolvimento.
5. Publique novamente os arquivos estáticos.

O cadastro exige e-mail, senha e nome de usuário único. Se a confirmação de e-mail estiver habilitada no Supabase, a pessoa precisará confirmar o endereço antes de entrar.

Os perfis públicos mostram o nome de usuário, a coleção e os status inatos. E-mail e senha não são armazenados nas tabelas públicas. Cada cópia é uma linha independente, com seis valores de status entre 0 e 20. As políticas RLS permitem leitura pública das coleções, mas somente o dono autenticado pode inserir, editar ou remover cópias.

O link público usa `/?profile=nome-de-usuario`. A lista do perfil abre com as variantes habilitadas; os filtros existentes continuam disponíveis e “Mostrar apenas os Aniimos que tenho” começa desativado.
