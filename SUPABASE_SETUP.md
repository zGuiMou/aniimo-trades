# ConfiguraÃ§Ã£o de contas e coleÃ§Ãµes

O site continua estÃ¡tico; o Supabase fornece autenticaÃ§Ã£o e armazenamento compartilhado.

1. Crie um projeto no Supabase.
2. No SQL Editor do projeto, execute [`supabase-schema.sql`](./supabase-schema.sql).
3. Copie a Project URL e a chave pÃºblica (anon/publishable) para `supabase-config.js`.
   NÃ£o use nem publique a chave `service_role`.
4. Em **Authentication â†’ URL Configuration**, configure o domÃ­nio do site como Site URL e adicione tambÃ©m os endereÃ§os de redirecionamento usados no desenvolvimento.
5. Publique novamente os arquivos estÃ¡ticos.

O cadastro exige e-mail, senha e nome de usuÃ¡rio Ãºnico. Se a confirmaÃ§Ã£o de e-mail estiver habilitada no Supabase, a pessoa precisarÃ¡ confirmar o endereÃ§o antes de entrar.

Os perfis pÃºblicos mostram o nome de usuÃ¡rio, a coleÃ§Ã£o e os status inatos. E-mail e senha nÃ£o sÃ£o armazenados nas tabelas pÃºblicas. Cada cÃ³pia Ã© uma linha independente, com seis valores de status entre 0 e 20. As polÃ­ticas RLS permitem leitura pÃºblica das coleÃ§Ãµes, mas somente o dono autenticado pode inserir, editar ou remover cÃ³pias.

O link pÃºblico usa `/?profile=nome-de-usuario`. A lista do perfil abre com as variantes habilitadas; os filtros existentes continuam disponÃ­veis e â€œMostrar apenas os Aniimos que tenhoâ€ comeÃ§a desativado.

## DiretÃ³rio e troca de repetidos

O botÃ£o **UsuÃ¡rios** abre um diretÃ³rio pÃºblico de perfis cadastrados. Ao visitar o perfil de outra pessoa estando autenticado, use **Comparar repetidos** para ver os Aniimos que somente vocÃª tem repetidos, os que somente a outra pessoa tem e os repetidos em comum. Um repetido Ã© um Aniimo (ou sua variante Umbral) com duas ou mais cÃ³pias.

Nenhuma alteraÃ§Ã£o adicional no banco Ã© necessÃ¡ria: as polÃ­ticas jÃ¡ permitem a leitura pÃºblica de `profiles` e `aniimo_copies`.

